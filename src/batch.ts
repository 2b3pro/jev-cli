// ============================================================================
// Batch: one preset applied to every line of stdin, JSONL out, input order kept
// ============================================================================

import type { EntryType, Questions, TypeSafeClient } from "@typesafe-ai/sdk";
import { orderedMap } from "./concurrency.ts";
import { describeError } from "./client.ts";
import { flattenAnswers, type Answer } from "./output.ts";

export interface BatchOptions {
  questions: Questions;
  model: string;
  /** Dot path to the state inside each JSON line (e.g. `body` or `message.text`). */
  field?: string;
  concurrency: number;
  raw: boolean;
  dryRun: boolean;
}

export interface BatchItem {
  /** 1-based line number in the input. */
  line: number;
  input: unknown;
}

export interface BatchSummary {
  total: number;
  failed: number;
}

/** Parse lines incrementally, preserving physical line numbers and skipping blanks. */
export async function* parseBatchLines(lines: AsyncIterable<string>): AsyncGenerator<BatchItem> {
  let line = 0;
  for await (const raw of lines) {
    line++;
    if (raw.trim() === "") continue;
    let input: unknown = raw;
    try {
      const value: unknown = JSON.parse(raw);
      if ((typeof value === "object" && value !== null) || typeof value === "string") input = value;
    } catch { /* Plain text is also valid input. */ }
    yield { line, input };
  }
}

/** The state to send for one item, or an error message. */
export function stateFor(item: BatchItem, field: string | undefined): { state: EntryType } | { error: string } {
  if (field === undefined) return { state: item.input as EntryType };

  let value: unknown = item.input;
  for (const key of field.split(".")) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) {
      return { error: `Field '${field}' not found` };
    }
    value = (value as Record<string, unknown>)[key];
  }
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    return { error: `Field '${field}' is empty` };
  }
  return { state: (typeof value === "object" ? value : String(value)) as EntryType };
}

/**
 * Run every item through the API with bounded concurrency.
 * Results are written as soon as all earlier lines are done, so output order matches input order.
 */
export async function runBatch(
  items: Iterable<BatchItem> | AsyncIterable<BatchItem>,
  client: TypeSafeClient | undefined,
  options: BatchOptions,
  write: (line: string) => void | Promise<void>,
): Promise<BatchSummary> {
  let total = 0;
  let failed = 0;

  async function processItem(item: BatchItem): Promise<string> {
    const resolved = stateFor(item, options.field);
    if ("error" in resolved) {
      failed++;
      return JSON.stringify({ line: item.line, input: item.input, error: { message: resolved.error } });
    }

    const request = { state: resolved.state, model: options.model, questions: options.questions };
    if (options.dryRun || !client) return JSON.stringify({ line: item.line, request });

    try {
      const { data, requestId } = await client.systemOne(request).withResponse();
      const answers = data.answers as Record<string, Answer>;
      return JSON.stringify(
        options.raw
          ? { line: item.line, input: item.input, answers: flattenAnswers(answers) }
          : { line: item.line, input: item.input, model: data.model, answers, usage: data.usage, request_id: requestId },
      );
    } catch (error) {
      failed++;
      return JSON.stringify({ line: item.line, input: item.input, error: describeError(error) });
    }
  }

  for await (const result of orderedMap(items, options.concurrency, processItem)) {
    await write(result);
    total++;
  }
  return { total, failed };
}
