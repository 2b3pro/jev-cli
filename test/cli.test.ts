import { describe, expect, test } from "bun:test";
import { parseArgs, UsageError } from "../src/args.ts";
import { main } from "../src/cli.ts";
import { resolveState } from "../src/io.ts";
import { fakeApi, fakeIo } from "./helpers.ts";

const PRESET_YAML = `
model: jev-preset
questions:
  needs_reply:
    type: noul
    instructions: Does this need a reply?
  kind:
    type: choice
    instructions: What kind of message is this?
    criteria:
      work: About a client or project
      personal: null
  urgency:
    type: score
    instructions: How urgent?
    criteria: [Later, Soon, Now]
`;

async function jev(argv: string[], options: Parameters<typeof fakeIo>[0] = {}) {
  const api = fakeApi();
  const { io, out, err } = fakeIo({ fetch: api.fetch, ...options });
  const code = await main(argv, io);
  return { code, out, err, calls: api.calls, stdout: out.join("\n") };
}

describe("argument parsing", () => {
  test("value flags in both forms, booleans, and positionals", () => {
    const args = parseArgs(["choose", "Which?", "a", "--state=hi", "--model", "m", "--raw", "-q", "b"]);
    expect(args.command).toBe("choose");
    expect(args.positionals).toEqual(["Which?", "a", "b"]);
    expect(args.values).toEqual({ state: "hi", model: "m" });
    expect(args.raw && args.quiet).toBe(true);
  });

  test("-- ends flag parsing", () => {
    expect(parseArgs(["ask", "--", "--not-a-flag"]).positionals).toEqual(["--not-a-flag"]);
  });

  test("unknown options and missing values are usage errors", () => {
    expect(() => parseArgs(["ask", "--bogus"])).toThrow(UsageError);
    expect(() => parseArgs(["ask", "q", "--state"])).toThrow("--state needs a value");
  });
});

describe("state resolution", () => {
  const { io } = fakeIo({ stdin: "piped text", files: { "note.txt": "from file" } });

  test("literal, @file, @@literal, and -", async () => {
    expect(await resolveState("literal", io)).toBe("literal");
    expect(await resolveState("@note.txt", io)).toBe("from file");
    expect(await resolveState("@@handle", io)).toBe("@handle");
    expect(await resolveState("-", io)).toBe("piped text");
  });

  test("falls back to piped stdin", async () => {
    expect(await resolveState(undefined, io)).toBe("piped text");
  });

  test("errors on a terminal with no state, on missing files, and on empty state", async () => {
    const tty = fakeIo().io;
    await expect(resolveState(undefined, tty)).rejects.toThrow("No state to evaluate");
    await expect(resolveState("@missing.txt", io)).rejects.toThrow("State file not found");
    await expect(resolveState("   ", io)).rejects.toThrow("State is empty");
  });
});

describe("single-question commands", () => {
  test("ask sends a noul question and prints the API result with request_id", async () => {
    const r = await jev(["ask", "Is this a complaint?", "--state", "I want a refund"]);
    expect(r.code).toBe(0);
    expect(r.calls[0]!.body).toEqual({
      state: "I want a refund",
      model: "jev-latest",
      questions: { answer: { type: "noul", instructions: "Is this a complaint?" } },
    });
    const result = JSON.parse(r.stdout);
    expect(result.answers.answer.noul).toBe(0.8);
    expect(result.request_id).toBe("req_1");
  });

  test("ask --yes/--no describe outcomes; --raw prints only P(yes)", async () => {
    const r = await jev(["ask", "Spam?", "--yes", "Unsolicited", "--raw"], { stdin: "Buy now" });
    expect(r.calls[0]!.body.questions.answer.criteria).toEqual({ true: "Unsolicited", false: null });
    expect(r.stdout).toBe("0.8");
  });

  test("choose parses label=description, keeps bare labels, and honors --name", async () => {
    const r = await jev(["choose", "Team?", "billing=Payments", "technical", "--name", "team", "--raw"], {
      stdin: "My card was charged twice",
    });
    expect(r.calls[0]!.body.questions.team.criteria).toEqual({ billing: "Payments", technical: null });
    expect(r.stdout).toBe("billing");
  });

  test("choose rejects fewer than two options and duplicate labels", async () => {
    expect((await jev(["choose", "Team?", "billing", "--state", "x"])).code).toBe(2);
    const dup = await jev(["choose", "Team?", "a", "a=again", "--state", "x"]);
    expect(dup.code).toBe(2);
    expect(dup.err[0]).toContain("Duplicate option label 'a'");
  });

  test("score sends ordered levels and --raw prints the expected score", async () => {
    const r = await jev(["score", "Urgent?", "low", "medium", "high", "--raw", "--state", "Server down"]);
    expect(r.calls[0]!.body.questions.answer).toEqual({ type: "score", instructions: "Urgent?", criteria: ["low", "medium", "high"] });
    expect(r.stdout).toBe("1.4");
  });

  test("score rejects more than ten levels", async () => {
    const levels = Array.from({ length: 11 }, (_, i) => `l${i}`);
    expect((await jev(["score", "Q?", ...levels, "--state", "x"])).code).toBe(2);
  });

  test("--model overrides the default and TYPESAFE_DEFAULT_MODEL sets it", async () => {
    expect((await jev(["ask", "Q?", "--state", "x", "--model", "jev-preview"])).calls[0]!.body.model).toBe("jev-preview");
    const env = await jev(["ask", "Q?", "--state", "x"], { env: { TYPESAFE_DEFAULT_MODEL: "jev-1.13.0" } });
    expect(env.calls[0]!.body.model).toBe("jev-1.13.0");
  });
});

describe("gate", () => {
  async function gate(p: number, flags: string[]) {
    const api = fakeApi({ noul: p });
    const { io, out } = fakeIo({ fetch: api.fetch, stdin: "some text" });
    return { code: await main(["gate", "Pass?", ...flags], io), out };
  }

  test("default threshold is P(yes) >= 0.5", async () => {
    expect((await gate(0.5, [])).code).toBe(0);
    expect((await gate(0.49, [])).code).toBe(1);
  });

  test("--min, --max, and a range", async () => {
    expect((await gate(0.75, ["--min", "0.7"])).code).toBe(0);
    expect((await gate(0.65, ["--min", "0.7"])).code).toBe(1);
    expect((await gate(0.1, ["--max", "0.2"])).code).toBe(0);
    expect((await gate(0.3, ["--max", "0.2"])).code).toBe(1);
    expect((await gate(0.5, ["--min", "0.4", "--max", "0.6"])).code).toBe(0);
    expect((await gate(0.7, ["--min", "0.4", "--max", "0.6"])).code).toBe(1);
  });

  test("records the decision in JSON output; -q prints nothing", async () => {
    const loud = await gate(0.9, ["--min", "0.7"]);
    expect(JSON.parse(loud.out.join("\n")).gate).toEqual({ pass: true, min: 0.7 });
    expect((await gate(0.9, ["-q"])).out).toEqual([]);
  });

  test("API errors exit 2, never 1, so a failure cannot read as 'no'", async () => {
    const api = fakeApi({ status: 403, errorBody: { detail: { error_type: "authentication_error", message: "Invalid API key" } } });
    const { io, err } = fakeIo({ fetch: api.fetch, stdin: "x" });
    expect(await main(["gate", "Pass?"], io)).toBe(2);
    expect(err[0]).toContain("API error 403: Invalid API key. Check TYPESAFE_API_KEY.");
  });

  test("rejects bad thresholds; --min/--max are gate-only", async () => {
    expect((await jev(["gate", "Q?", "--min", "1.5", "--state", "x"])).code).toBe(2);
    expect((await jev(["gate", "Q?", "--min", "0.8", "--max", "0.2", "--state", "x"])).code).toBe(2);
    expect((await jev(["ask", "Q?", "--min", "0.5", "--state", "x"])).code).toBe(2);
  });
});

describe("run (presets)", () => {
  const files = { "/presets/triage.yaml": PRESET_YAML, "./local.json": JSON.stringify({ questions: { ok: { type: "noul" } } }) };
  const env = { JEV_PRESETS_DIR: "/presets" };

  test("loads a named preset, uses its model, and asks every question in one call", async () => {
    const r = await jev(["run", "triage", "--state", "Can you send the invoice?"], { files, env });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.body.model).toBe("jev-preset");
    expect(Object.keys(r.calls[0]!.body.questions)).toEqual(["needs_reply", "kind", "urgency"]);
  });

  test("--raw flattens answers to name: value", async () => {
    const r = await jev(["run", "triage", "--raw", "--state", "x"], { files, env });
    expect(JSON.parse(r.stdout)).toEqual({ needs_reply: 0.8, kind: "work", urgency: 1.4 });
  });

  test("loads a preset by path; --model beats the preset's model", async () => {
    const r = await jev(["run", "./local.json", "--state", "x", "--model", "jev-preview"], { files, env });
    expect(r.code).toBe(0);
    expect(r.calls[0]!.body.model).toBe("jev-preview");
  });

  test("missing and malformed presets are usage errors", async () => {
    const missing = await jev(["run", "nope", "--state", "x"], { files, env });
    expect(missing.code).toBe(2);
    expect(missing.err[0]).toContain("Preset not found: /presets/nope.{yaml,yml,json}");

    const bad = await jev(["run", "./bad.yaml", "--state", "x"], {
      files: { "./bad.yaml": "questions:\n  q:\n    type: score\n    criteria: [only-one]\n" },
    });
    expect(bad.code).toBe(2);
    expect(bad.err[0]).toContain("needs a criteria list of at least two levels");
  });
});

describe("batch", () => {
  const files = { "/presets/triage.yaml": PRESET_YAML };
  const env = { JEV_PRESETS_DIR: "/presets" };

  test("JSON lines with --field (dot path), plain text lines, blank lines skipped", async () => {
    const stdin = ['{"id":1,"msg":{"body":"Invoice please"}}', "", '{"id":2,"msg":{"body":"Lunch?"}}'].join("\n");
    const r = await jev(["batch", "triage", "--field", "msg.body", "--raw"], { files, env, stdin });
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => c.body.state)).toEqual(["Invoice please", "Lunch?"]);
    const lines = r.out.map((line) => JSON.parse(line));
    expect(lines.map((l) => l.line)).toEqual([1, 3]);
    expect(lines[0].input).toEqual({ id: 1, msg: { body: "Invoice please" } });
    expect(lines[0].answers).toEqual({ needs_reply: 0.8, kind: "work", urgency: 1.4 });
  });

  test("plain text lines become the state", async () => {
    const r = await jev(["batch", "triage"], { files, env, stdin: "first message\nsecond message\n" });
    expect(r.calls.map((c) => c.body.state).sort()).toEqual(["first message", "second message"]);
  });

  test("keeps input order even when later lines finish first", async () => {
    const api = fakeApi({ delayMs: (state) => (state === "slow" ? 60 : 0) });
    const { io, out } = fakeIo({ fetch: api.fetch, files, env, stdin: "slow\nfast1\nfast2\nfast3" });
    expect(await main(["batch", "triage", "--concurrency", "4"], io)).toBe(0);
    expect(out.map((line) => JSON.parse(line).input)).toEqual(["slow", "fast1", "fast2", "fast3"]);
  });

  test("a missing field is a per-line error; the batch continues and exits 2", async () => {
    const stdin = '{"body":"ok"}\n{"other":"no body"}\n{"body":"also ok"}';
    const r = await jev(["batch", "triage", "--field", "body"], { files, env, stdin });
    expect(r.code).toBe(2);
    expect(r.calls).toHaveLength(2);
    const lines = r.out.map((line) => JSON.parse(line));
    expect(lines[1].error.message).toBe("Field 'body' not found");
    expect(lines[2].answers.needs_reply.noul).toBe(0.8);
    expect(r.err[0]).toBe("jev: 1 of 3 lines failed");
  });

  test("API failures are reported per line", async () => {
    const api = fakeApi({ status: 422, errorBody: { detail: [{ loc: ["body", "state"], msg: "Field required" }] } });
    const { io, out } = fakeIo({ fetch: api.fetch, files, env, stdin: "a\nb" });
    expect(await main(["batch", "triage"], io)).toBe(2);
    expect(JSON.parse(out[0]!).error).toEqual({ message: "API error 422: body.state: Field required.", status: 422, request_id: "req_1" });
  });

  test("needs piped input and rejects --state", async () => {
    expect((await jev(["batch", "triage"], { files, env })).code).toBe(2);
    expect((await jev(["batch", "triage", "--state", "x"], { files, env, stdin: "a" })).code).toBe(2);
  });
});

describe("configuration and dry runs", () => {
  test("--dry-run prints the request, makes no call, and needs no key", async () => {
    const r = await jev(["choose", "Team?", "a", "b", "--state", "x", "--dry-run"], { env: { TYPESAFE_API_KEY: undefined } });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(0);
    expect(JSON.parse(r.stdout).questions.answer.criteria).toEqual({ a: null, b: null });
  });

  test("a missing key is an actionable error", async () => {
    const r = await jev(["ask", "Q?", "--state", "x"], { env: { TYPESAFE_API_KEY: undefined } });
    expect(r.code).toBe(2);
    expect(r.err[0]).toContain("No API key");
  });

  test("falls back to the keychain when the env var is unset", async () => {
    const r = await jev(["ask", "Q?", "--state", "x"], { env: { TYPESAFE_API_KEY: undefined }, keychain: "kc-key" });
    expect(r.code).toBe(0);
  });

  test("models --raw lists names", async () => {
    expect((await jev(["models", "--raw"])).stdout).toBe("jev-1.13.0");
  });

  test("help, version, and unknown commands", async () => {
    expect((await jev(["--help"])).stdout).toContain("EXIT CODES");
    expect((await jev(["--version"])).stdout).toMatch(/^\d+\.\d+\.\d+$/);
    expect((await jev(["frobnicate"])).code).toBe(2);
  });
});
