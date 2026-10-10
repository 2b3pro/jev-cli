import type { Fetch } from "@typesafe-ai/sdk";
import type { Io } from "../src/io.ts";

export interface Call {
  url: string;
  method: string | undefined;
  body: any;
}

export interface FakeApiOptions {
  /** P(yes) for every noul question, or per state. */
  noul?: number | ((state: unknown) => number);
  /** Delay before responding, per state (for ordering tests). */
  delayMs?: (state: unknown) => number;
  /** Fail every request with this status and body. */
  status?: number;
  errorBody?: unknown;
}

/** A stand-in for api.typesafe.ai that answers deterministically and records every call. */
export function fakeApi(options: FakeApiOptions = {}) {
  const calls: Call[] = [];

  const fetch: Fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method, body });

    const headers = { "content-type": "application/json", "x-typesafe-request-id": `req_${calls.length}` };
    const reply = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers });

    if (options.status) return reply(options.status, options.errorBody ?? { detail: "error" });
    if (url.endsWith("/v1/models")) {
      return reply(200, { models: [{ name: "jev-1.13.0", description: "Jev", release_date: "2026-09-15" }] });
    }

    const delay = options.delayMs?.(body.state) ?? 0;
    if (delay > 0) await Bun.sleep(delay);

    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries<any>(body.questions)) {
      if (q.type === "noul") {
        const p = typeof options.noul === "function" ? options.noul(body.state) : (options.noul ?? 0.8);
        answers[name] = { type: "noul", noul: p };
      } else if (q.type === "choice") {
        const labels = Object.keys(q.criteria);
        answers[name] = {
          type: "choice",
          choice: labels[0],
          confidence: 0.9,
          probabilities: Object.fromEntries(labels.map((label, i) => [label, i === 0 ? 0.9 : 0.1 / (labels.length - 1)])),
        };
      } else {
        const levels: unknown[] = q.criteria;
        answers[name] = {
          type: "score",
          score: 1.4,
          confidence: 0.7,
          legend: Object.fromEntries(levels.map((level, i) => [i, level])),
          probabilities: Object.fromEntries(levels.map((_, i) => [i, 1 / levels.length])),
        };
      }
    }
    return reply(200, { model: "jev-1.13.0", answers, usage: { input_tokens: 42, output_tokens: 3 } });
  };

  return { fetch, calls };
}

export interface FakeIoOptions {
  /** Piped stdin. Undefined means an interactive terminal. */
  stdin?: string;
  files?: Record<string, string>;
  env?: Record<string, string | undefined>;
  keychain?: string;
  fetch?: Fetch;
}

export function fakeIo(options: FakeIoOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    readStdin: async () => options.stdin ?? "",
    readLines: async function* () { yield* (options.stdin ?? "").split(/\r?\n/); },
    writeLine: async (line) => { out.push(line); },
    stdinIsTTY: options.stdin === undefined,
    readFile: async (path) => options.files?.[path],
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: { TYPESAFE_API_KEY: "test-key", ...options.env },
    keychain: () => options.keychain,
    fetch: options.fetch,
  };
  return { io, out, err };
}
