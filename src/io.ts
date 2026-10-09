// ============================================================================
// I/O boundary: everything the CLI touches outside its own code
// ============================================================================

import { execFileSync } from "node:child_process";
import type { Fetch } from "@typesafe-ai/sdk";
import { UsageError } from "./args.ts";

export interface Io {
  /** Read all of stdin as text. */
  readStdin(): Promise<string>;
  /** True when stdin is an interactive terminal (nothing piped in). */
  stdinIsTTY: boolean;
  /** Read a file as text; undefined when it does not exist. */
  readFile(path: string): Promise<string | undefined>;
  /** Write one line to stdout. */
  out(line: string): void;
  /** Write one line to stderr. */
  err(line: string): void;
  env: Record<string, string | undefined>;
  /** Look up a generic password by service name (macOS Keychain). */
  keychain(service: string): string | undefined;
  /** HTTP transport override, used by tests. */
  fetch?: Fetch;
}

function macKeychain(service: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const secret = execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return secret || undefined;
  } catch {
    return undefined;
  }
}

export function processIo(): Io {
  return {
    readStdin: () => Bun.stdin.text(),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    async readFile(path) {
      const file = Bun.file(path);
      return (await file.exists()) ? file.text() : undefined;
    },
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    keychain: macKeychain,
  };
}

/**
 * Resolve the text Jev evaluates.
 *
 *   --state "text"   literal text
 *   --state @path    file contents (`@@text` passes a literal leading `@`)
 *   --state -        stdin
 *   (no flag)        stdin, when something is piped in
 */
export async function resolveState(flag: string | undefined, io: Io): Promise<string> {
  let state: string;

  if (flag === undefined) {
    if (io.stdinIsTTY) {
      throw new UsageError("No state to evaluate: pass --state <text|@file|->, or pipe text on stdin");
    }
    state = await io.readStdin();
  } else if (flag === "-") {
    state = await io.readStdin();
  } else if (flag.startsWith("@@")) {
    state = flag.slice(1);
  } else if (flag.startsWith("@")) {
    const path = flag.slice(1);
    const text = await io.readFile(path);
    if (text === undefined) throw new UsageError(`State file not found: ${path}`);
    state = text;
  } else {
    state = flag;
  }

  if (state.trim() === "") throw new UsageError("State is empty: Jev needs some text to evaluate");
  return state;
}
