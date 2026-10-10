#!/usr/bin/env bun
// ============================================================================
// jev: command-line interface for TypeSafe AI's Jev System One model
// ============================================================================

import type { Question, TypeSafeClient } from "@typesafe-ai/sdk";
import { numberFlag, parseArgs, UsageError, type ParsedArgs } from "./args.ts";
import { parseBatchLines, runBatch } from "./batch.ts";
import { createClient, defaultModel, describeError, getLogger } from "./client.ts";
import { processIo, resolveState, type Io } from "./io.ts";
import { answerValue, flattenAnswers, type Answer } from "./output.ts";
import { choiceQuestion, loadPreset, scoreQuestion, yesNoQuestion } from "./questions.ts";

export const VERSION = "0.1.1";

/** Exit codes. `gate` uses FAIL for "no"; every error is ERROR, so FAIL is never ambiguous. */
export const EXIT = { OK: 0, FAIL: 1, ERROR: 2 } as const;

const HELP = `jev ${VERSION}: fast yes/no, choice and score decisions with TypeSafe AI's Jev model

USAGE
  jev <command> [arguments] [options]

COMMANDS
  ask    <question>                    Yes/no. Answer is P(yes), 0 to 1.
  gate   <question> [--min p] [--max p] Yes/no as an exit code: 0 pass, 1 fail.
  choose <question> <option>...        Pick one option. Options: label or label=description.
  score  <question> <level>...         Rate on 2-10 ordered levels, lowest first.
  run    <preset|file>                 Ask every question in a preset about one state.
  batch  <preset|file>                 Run a preset over each line of stdin (JSONL out).
  models                               List available models.

STATE (the text Jev evaluates)
  --state <text>      Literal text
  --state @<file>     File contents (@@text passes a literal leading @)
  --state -           Read stdin
  (no --state)        Read stdin when input is piped

OPTIONS
  --raw               Print only the answer: P(yes), label, or score.
                      run prints {name: value}; batch prints flattened answers.
  -q, --quiet         Print nothing; use the exit code.
  --dry-run           Print the request instead of sending it (no API key needed).
  --model <name>      Model (default: $TYPESAFE_DEFAULT_MODEL or jev-latest).
  --name <key>        Answer key for ask/gate/choose/score (default: answer).
  --yes <text>        ask/gate: describe what "yes" means.
  --no <text>         ask/gate: describe what "no" means.
  --min <p>           gate: pass when P(yes) >= p (default 0.5).
  --max <p>           gate: pass when P(yes) <= p. With --min, pass inside the range.
  --field <path>      batch: dot path to the state in each JSON line (e.g. body).
  --concurrency <n>   batch: parallel requests, 1-32 (default 8).
  --timeout <ms>      Per-attempt timeout (default 10000).
  --retries <n>       Retries on 408/429/5xx and connection errors (default 2).
  --verbose           Log request summaries to stderr.
  -h, --help          Show this help.
  -v, --version       Show the version.

PRESETS
  A YAML or JSON file whose questions use the API's own schema:

    model: jev-latest            # optional
    questions:
      needs_reply: { type: noul, instructions: Does this email need a reply from me? }
      kind:
        type: choice
        instructions: What kind of email is this?
        criteria: { personal: From friends or family, work: About a client or project, promo: null }
      urgency:
        type: score
        instructions: How urgent is it?
        criteria: [Can wait a week, This week, Today, Right now]

  Named presets live in $JEV_PRESETS_DIR, else ~/.config/jev/presets/<name>.yaml

EXAMPLES
  jev ask "Is this a complaint?" --state @ticket.txt
  cat email.txt | jev choose "Which team should handle this?" billing technical sales
  jev score "How urgent is this?" low medium high critical --raw < msg.txt
  if jev gate "Does this need a reply from me?" --min 0.7 -q < msg.txt; then echo reply; fi
  jev run email-triage --state @email.txt --raw
  jq -c '{id, body}' inbox.json | jev batch email-triage --field body > triaged.jsonl
  jev choose "Which option fits what I said matters most?" "stay=Keep the current plan" \\
    "switch=Take the new offer" --state @situation.md

OUTPUT
  JSON on stdout: {model, answers, usage, request_id}. batch writes one JSON object per
  input line, in input order, with errors reported per line. Messages go to stderr.

EXIT CODES
  0  success (gate: passed)
  1  gate: did not pass
  2  any error: bad usage, missing key, API or network failure, or a failed batch line

CONFIGURATION
  TYPESAFE_API_KEY        API key; on macOS also read from Keychain service TYPESAFE_API_KEY
  TYPESAFE_BASE_URL       API root (default https://api.typesafe.ai)
  TYPESAFE_DEFAULT_MODEL  Default model (default jev-latest)
  JEV_PRESETS_DIR         Preset directory

Unofficial; not affiliated with TypeSafe AI. Docs: https://docs.typesafe.ai`;

interface Context {
  args: ParsedArgs;
  io: Io;
}

function print(ctx: Context, value: unknown): void {
  if (ctx.args.quiet) return;
  ctx.io.out(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function client(ctx: Context): TypeSafeClient {
  const { values, verbose } = ctx.args;
  return createClient(ctx.io, {
    timeout: numberFlag("timeout", values.timeout, { min: 1, max: 600_000, integer: true }),
    retries: numberFlag("retries", values.retries, { min: 0, max: 10, integer: true }),
    verbose,
  });
}

// ----------------------------------------------------------------------------
// Commands
// ----------------------------------------------------------------------------

/** ask, gate, choose, score: one question about one state. */
async function single(ctx: Context, command: "ask" | "gate" | "choose" | "score"): Promise<number> {
  const { positionals, values } = ctx.args;
  const [instructions, ...rest] = positionals;
  if (!instructions?.trim()) throw new UsageError(`${command} needs a question, e.g. jev ${command} "Is this spam?"`);

  let question: Question;
  if (command === "ask" || command === "gate") {
    if (rest.length > 0) throw new UsageError(`${command} takes one question; quote it ("...")`);
    question = yesNoQuestion(instructions, values.yes, values.no);
  } else if (command === "choose") {
    question = choiceQuestion(instructions, rest);
  } else {
    question = scoreQuestion(instructions, rest);
  }

  let min = numberFlag("min", values.min, { min: 0, max: 1 });
  const max = numberFlag("max", values.max, { min: 0, max: 1 });
  if (command !== "gate" && (min !== undefined || max !== undefined)) {
    throw new UsageError("--min and --max only apply to gate");
  }
  if (command === "gate" && min === undefined && max === undefined) min = 0.5;
  if (min !== undefined && max !== undefined && min > max) throw new UsageError("--min cannot be greater than --max");

  const name = values.name ?? "answer";
  const state = await resolveState(values.state, ctx.io);
  const request = { state, model: values.model ?? defaultModel(ctx.io), questions: { [name]: question } };

  if (ctx.args.dryRun) {
    print(ctx, request);
    return EXIT.OK;
  }

  const { data, requestId } = await client(ctx).systemOne(request).withResponse();
  const answer = data.answers[name] as Answer;

  if (command === "gate") {
    const p = answerValue(answer) as number;
    const pass = (min === undefined || p >= min) && (max === undefined || p <= max);
    print(ctx, ctx.args.raw ? String(p) : { ...data, request_id: requestId, gate: { pass, min, max } });
    return pass ? EXIT.OK : EXIT.FAIL;
  }

  print(ctx, ctx.args.raw ? String(answerValue(answer)) : { ...data, request_id: requestId });
  return EXIT.OK;
}

/** run: every question in a preset about one state. */
async function run(ctx: Context): Promise<number> {
  const [ref, ...extra] = ctx.args.positionals;
  if (!ref) throw new UsageError("run needs a preset name or file, e.g. jev run triage");
  if (extra.length > 0) throw new UsageError("run takes one preset");

  const preset = await loadPreset(ref, ctx.io);
  const state = await resolveState(ctx.args.values.state, ctx.io);
  const model = ctx.args.values.model ?? preset.model ?? defaultModel(ctx.io);
  const request = { state, model, questions: preset.questions };

  if (ctx.args.dryRun) {
    print(ctx, request);
    return EXIT.OK;
  }

  const { data, requestId } = await client(ctx).systemOne(request).withResponse();
  const answers = data.answers as Record<string, Answer>;
  print(ctx, ctx.args.raw ? flattenAnswers(answers) : { ...data, request_id: requestId });
  return EXIT.OK;
}

/** batch: a preset over every line of stdin. */
async function batch(ctx: Context): Promise<number> {
  const { positionals, values } = ctx.args;
  const [ref, ...extra] = positionals;
  if (!ref) throw new UsageError("batch needs a preset name or file, e.g. jev batch triage < items.jsonl");
  if (extra.length > 0) throw new UsageError("batch takes one preset");
  if (values.state !== undefined) throw new UsageError("batch reads its states from stdin; --state does not apply");
  if (ctx.io.stdinIsTTY) throw new UsageError("batch reads JSON lines or plain text lines from stdin; pipe some in");

  const preset = await loadPreset(ref, ctx.io);
  const concurrency = numberFlag("concurrency", values.concurrency, { min: 1, max: 32, integer: true }) ?? 8;
  const items = parseBatchLines(ctx.io.readLines());

  const options = {
    questions: preset.questions,
    model: values.model ?? preset.model ?? defaultModel(ctx.io),
    field: values.field,
    concurrency,
    raw: ctx.args.raw,
    dryRun: ctx.args.dryRun,
  };
  const api = ctx.args.dryRun ? undefined : client(ctx);
  const write = ctx.args.quiet ? () => {} : ctx.io.writeLine;
  const summary = await runBatch(items, api, options, write);
  if (summary.total === 0) throw new UsageError("batch input is empty");

  if (!ctx.args.dryRun) {
    const log = await getLogger(ctx.io);
    const data = { preset: preset.source, total: summary.total, failed: summary.failed };
    if (summary.failed > 0) log.error("Batch finished with failures", data);
    else log.info("Batch finished", data);
  }
  if (summary.failed > 0) ctx.io.err(`jev: ${summary.failed} of ${summary.total} lines failed`);
  return summary.failed > 0 ? EXIT.ERROR : EXIT.OK;
}

async function models(ctx: Context): Promise<number> {
  if (ctx.args.positionals.length > 0) throw new UsageError("models takes no arguments");
  const cards = await client(ctx).models.list();
  print(ctx, ctx.args.raw ? cards.map((card) => card.name).join("\n") : cards);
  return EXIT.OK;
}

// ----------------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------------

/** Run the CLI and return its exit code. Never throws. */
export async function main(argv: string[], io: Io): Promise<number> {
  let ctx: Context | undefined;
  try {
    const args = parseArgs(argv);
    ctx = { args, io };

    if (args.version) {
      io.out(VERSION);
      return EXIT.OK;
    }
    if (args.help || !args.command || args.command === "help") {
      io.out(HELP);
      return EXIT.OK;
    }

    switch (args.command) {
      case "ask":
      case "gate":
      case "choose":
      case "score":
        return await single(ctx, args.command);
      case "run":
        return await run(ctx);
      case "batch":
        return await batch(ctx);
      case "models":
        return await models(ctx);
      default:
        throw new UsageError(`Unknown command '${args.command}'`);
    }
  } catch (error) {
    const summary = describeError(error);
    io.err(`jev: ${summary.message}`);
    if (error instanceof UsageError) {
      io.err("Run 'jev --help' for usage.");
    } else {
      const log = await getLogger(io);
      log.error("Request failed", { command: ctx?.args.command, ...summary }, error);
    }
    return EXIT.ERROR;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), processIo());
}
