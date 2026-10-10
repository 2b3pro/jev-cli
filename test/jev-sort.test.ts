import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fakeIo } from "./helpers.ts";
import { basename, join } from "node:path";
import {
  buildName,
  createDecisions,
  cleanPart,
  datesIn,
  discoverCategories,
  learnedExamples,
  main,
  verifyDate,
  type Deps,
  type Runner,
} from "../scripts/jev-sort.ts";

describe("date verification", () => {
  test("finds dates in common formats, with a two-digit-year pivot", () => {
    const found = datesIn("Issued 7/10/98. Due 2026-10-31. Sent October 1, 2026. Valid 5 Mar 2025. 転送期間：2021.8.6", 2026);
    expect([...found].sort()).toEqual(["1998-07-10", "2021-08-06", "2025-03-05", "2026-10-01", "2026-10-31"]);
  });

  test("keeps a printed date, falls back to a printed year, else drops it", () => {
    expect(verifyDate("2026-10-01", "Date: 10/01/2026")).toBe("2026-10-01");
    expect(verifyDate("2026-09-30", "Period: September 2026")).toBe("2026");
    expect(verifyDate("2019-01-01", "no year here")).toBe("");
    expect(verifyDate("not a date", "2026")).toBe("");
  });
});

describe("name cleanup", () => {
  test("strips OCR debris, stray letters, and repeated words", () => {
    expect(cleanPart("FRAMESDIRECT-¢o™ Premium")).toBe("FRAMESDIRECT Premium");
    expect(cleanPart("Final Spectacle Rx ( Progressive )")).toBe("Final Spectacle Rx Progressive");
    expect(cleanPart("CABLE CABLE TESTER")).toBe("CABLE TESTER");
    expect(cleanPart("a I & 3 x")).toBe("a I & 3");
  });

  test("drops a sender repeated in the title; keeps date first", () => {
    expect(buildName("", "NETWORK CABLE TESTER", "NETWORK CABLE TESTER")).toBe("NETWORK CABLE TESTER");
    expect(buildName("2024", "Hippo", "Hippo Insurance Renewal")).toBe("2024 Hippo Insurance Renewal");
    expect(buildName("2020-10-20", "Red Rock Vision, LLC", "Spectacle Rx")).toBe("2020-10-20 Red Rock Vision LLC Spectacle Rx");
  });
});

// ----------------------------------------------------------------------------
// End-to-end with temp folders and fake tools
// ----------------------------------------------------------------------------

let root: string;
let inbox: string;
let into: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jev-sort-test-"));
  inbox = join(root, "_Inbox");
  into = root;
  for (const dir of ["_Inbox", "Medical", "Taxes", "2024", ".hidden", "_Manual"]) mkdirSync(join(root, dir));
  writeFileSync(join(root, "Medical", "2024 Quest Lab Results.pdf"), "x");
  writeFileSync(join(root, "Medical", "2024_11_08_21_17_09.pdf"), "x");
  spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => { mock.restore(); rmSync(root, { recursive: true, force: true }); });

function drop(name: string) {
  writeFileSync(join(inbox, name), "%PDF-fake");
}

interface Fake {
  /** Text pdftotext returns per file name ("" = bare scan). */
  text: Record<string, string>;
  ocrText?: Record<string, string>;
  /** Label and confidence jev picks for a given text. */
  pick: (text: string) => [string, number];
  name?: { date: string; sender: string; title: string };
  garble?: number;
}

function deps(fake: Fake, calls: string[][] = []): Deps {
  const runner: Runner = async (cmd, stdin) => {
    calls.push(cmd);
    const ok = (out: string) => ({ out, err: "", code: 0 });
    switch (cmd[0]) {
      case "pdftotext":
        return ok(fake.text[basename(cmd[3]!)] ?? "");
      case "fm":
        if (cmd[1] === "available") return ok("System model available");
        return ok(JSON.stringify(fake.name ?? { date: "", sender: "", title: "" }));
      case "osascript":
        return ok("");
      default:
        return { out: "", err: `unexpected ${cmd[0]}`, code: 127 };
    }
  };
  const io = fakeIo({ fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const question = body.questions.answer;
    calls.push(["api", question.type]);
    let answer;
    if (question.type === "noul") answer = { type: "noul", noul: fake.garble ?? 0.05 };
    else {
      const labels = Object.keys(question.criteria);
      const [label, confidence] = fake.pick(body.state);
      answer = { type: "choice", choice: label, confidence,
        probabilities: Object.fromEntries(labels.map((l) => [l, l === label ? confidence : (1 - confidence) / (labels.length - 1)])) };
    }
    return Response.json({ model: "jev-latest", answers: { answer }, usage: { input_tokens: 42, output_tokens: 3 } });
  } }).io;
  return {
    decisions: createDecisions(io),
    runner,
    ocr: async (pdf) => fake.ocrText?.[basename(pdf)] ?? "",
    log: () => {},
  };
}

const files = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith(".")).sort() : []);

describe("categories", () => {
  test("skips hidden, underscore, and year folders", () => {
    expect(discoverCategories(root)).toEqual(["Medical", "Taxes"]);
  });

  test("learns from filed names but ignores scanner-default names", () => {
    expect(learnedExamples(join(root, "Medical"))).toEqual(["2024 Quest Lab Results"]);
  });
});

describe("jev-sort", () => {
  const medical = "Patient visit summary and lab results from the clinic";

  test("dry run plans but changes nothing", async () => {
    drop("scan1.pdf");
    const code = await main([inbox, "--into", into], deps({ text: { "scan1.pdf": medical }, pick: () => ["Medical", 0.9] }));
    expect(code).toBe(0);
    expect(files(inbox)).toEqual(["scan1.pdf"]);
    expect(files(join(root, "Medical"))).toHaveLength(2);
  });

  test("--apply files confident documents and sends unsure ones to the review folder", async () => {
    drop("a.pdf");
    drop("b.pdf");
    const fake = deps({ text: { "a.pdf": medical, "b.pdf": "Some unclear page of text here" }, pick: (t) => (t === medical ? ["Medical", 0.9] : ["Taxes", 0.4]) });
    expect(await main([inbox, "--into", into, "--review-dir", join(root, "_Manual"), "--apply"], fake)).toBe(0);
    expect(files(inbox)).toEqual([]);
    expect(files(join(root, "Medical"))).toContain("a.pdf");
    expect(files(join(root, "_Manual"))).toEqual(["b.pdf"]);
  });

  test("bare scans use the injected OCR; unreadable scans go to review", async () => {
    drop("scan.pdf");
    drop("blank.pdf");
    const calls: string[][] = [];
    const fake = deps({ text: {}, ocrText: { "scan.pdf": medical }, pick: () => ["Medical", 0.9] }, calls);
    await main([inbox, "--into", into, "--apply"], fake);
    expect(files(join(root, "Medical"))).toContain("scan.pdf");
    expect(files(join(root, "_Review"))).toEqual(["blank.pdf"]);
    expect(calls.filter((c) => c[0] === "api")).toHaveLength(1);
  });

  test("--rename --by-year uses the verified date and never overwrites", async () => {
    mkdirSync(join(root, "Medical", "2024"));
    writeFileSync(join(root, "Medical", "2024", "2024-03-05 Quest Lab Results.pdf"), "existing");
    drop("scan.pdf");
    const fake = deps({
      text: { "scan.pdf": `${medical}. Collected 03/05/2024.` },
      pick: () => ["Medical", 0.9],
      name: { date: "2024-03-05", sender: "Quest", title: "Lab Results" },
    });
    await main([inbox, "--into", into, "--rename", "--by-year", "--apply"], fake);
    expect(files(join(root, "Medical", "2024"))).toEqual(["2024-03-05 Quest Lab Results (2).pdf", "2024-03-05 Quest Lab Results.pdf"]);
  });

  test("a garbled proposed name keeps the original name", async () => {
    drop("2020_12_03.pdf");
    const fake = deps({
      text: { "2020_12_03.pdf": medical },
      pick: () => ["Medical", 0.9],
      name: { date: "", sender: "Japan Pension Service", title: "RAMU RSBHAB B5HAS" },
      garble: 0.88,
    });
    await main([inbox, "--into", into, "--rename", "--apply"], fake);
    expect(files(join(root, "Medical"))).toContain("2020_12_03.pdf");
  });

  test("--tag and --comment talk to Finder only after the move", async () => {
    drop("a.pdf");
    const calls: string[][] = [];
    await main([inbox, "--into", into, "--tag", "--comment", "--apply"], deps({ text: { "a.pdf": medical }, pick: () => ["Medical", 0.9] }, calls));
    const finder = calls.filter((c) => c[0] === "osascript");
    expect(finder).toHaveLength(2);
    expect(finder.every((c) => c.includes(join(root, "Medical", "a.pdf")))).toBe(true);
    expect(finder[0]!.at(-1)).toBe("Medical");
    expect(finder[1]!.at(-1)).toMatch(/^jev-sort \d{4}-\d{2}-\d{2}: Medical \(90%\)/);
  });

  test("a missing or malformed --describe file is a clean error", async () => {
    const d = deps({ text: {}, pick: () => ["Medical", 1] });
    expect(await main([inbox, "--into", into, "--describe", join(root, "nope.yaml")], d)).toBe(2);
    writeFileSync(join(root, "list.yaml"), "- just\n- a list\n");
    expect(await main([inbox, "--into", into, "--describe", join(root, "list.yaml")], d)).toBe(2);
  });

  test("rejects unknown categories and missing folders", async () => {
    expect(await main([inbox, "--into", into, "--categories", "Medical,Nope"], deps({ text: {}, pick: () => ["Medical", 1] }))).toBe(2);
    expect(await main([join(root, "missing"), "--into", into], deps({ text: {}, pick: () => ["Medical", 1] }))).toBe(2);
  });
});


test("parallel preparation keeps moves, collisions, and output in filename order", async () => {
  for (const file of ["a.pdf", "b.pdf", "c.pdf"]) drop(file);
  const text = "Patient visit summary and lab results from the clinic";
  const d = deps({ text: { "a.pdf": text, "b.pdf": text, "c.pdf": text },
    pick: () => ["Medical", 0.9], name: { date: "", sender: "Quest", title: "Lab Results" } });
  const original = d.runner;
  let active = 0;
  let peak = 0;
  const completed: string[] = [];
  d.runner = async (cmd, stdin) => {
    if (cmd[0] !== "pdftotext") return original(cmd, stdin);
    active++;
    peak = Math.max(peak, active);
    const file = basename(cmd[3]!);
    await Bun.sleep(file === "a.pdf" ? 40 : 5);
    active--;
    completed.push(file);
    return original(cmd, stdin);
  };
  const output: string[] = [];
  spyOn(console, "log").mockImplementation((s) => { output.push(String(s)); });
  expect(await main([inbox, "--into", into, "--concurrency", "2", "--rename", "--json", "--apply"], d)).toBe(0);
  expect(peak).toBe(2);
  expect(completed[0]).toBe("b.pdf");
  const items = output.map((s) => JSON.parse(s));
  expect(items.map((i) => i.file)).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
  expect(items.map((i) => basename(i.dest))).toEqual(["Quest Lab Results.pdf", "Quest Lab Results (2).pdf", "Quest Lab Results (3).pdf"]);
  expect(items.every((i) => i.applied)).toBe(true);
  expect(files(inbox)).toEqual([]);
});

test("sort validates concurrency before doing document work", async () => {
  const calls: string[][] = [];
  const d = deps({ text: {}, pick: () => ["Medical", 1] }, calls);
  for (const value of ["0", "9", "1.5", "NaN"]) {
    expect(await main([inbox, "--into", into, "--concurrency", value], d)).toBe(2);
  }
  expect(calls).toEqual([]);
});

test("shared SDK client looks up credentials once for parallel classification and name checks", async () => {
  const { fakeApi } = await import("./helpers.ts");
  const api = fakeApi();
  const { io } = fakeIo({ fetch: api.fetch, env: { TYPESAFE_API_KEY: undefined, TYPESAFE_DEFAULT_MODEL: "custom-model" } });
  let lookups = 0;
  io.keychain = () => { lookups++; return "test-key"; };
  const decisions = createDecisions(io);
  await Promise.all([
    decisions.classify("x".repeat(70_000), { "A=B": "description", Other: null }),
    decisions.classify("another document", { "A=B": "description", Other: null }),
    decisions.garbleProbability("Proposed name"),
  ]);
  expect(lookups).toBe(1);
  expect(api.calls).toHaveLength(3);
  expect(api.calls[0]!.body.state).toHaveLength(60_000);
  expect(api.calls[0]!.body.questions.answer.criteria).toEqual({ "A=B": "description", Other: null });
  expect(api.calls.every((call) => call.body.model === "custom-model")).toBe(true);
});

test("classification failure leaves its file untouched and does not stop later files", async () => {
  drop("a.pdf"); drop("b.pdf");
  const d = deps({ text: { "a.pdf": "First readable document from the clinic", "b.pdf": "Second readable document from the clinic" }, pick: () => ["Medical", 0.9] });
  const classify = d.decisions!.classify;
  d.decisions!.classify = async (text, categories) => {
    if (text.startsWith("First")) throw new Error("API unavailable");
    return classify(text, categories);
  };
  expect(await main([inbox, "--into", into, "--apply"], d)).toBe(2);
  expect(files(inbox)).toEqual(["a.pdf"]);
  expect(files(join(root, "Medical"))).toContain("b.pdf");
});
