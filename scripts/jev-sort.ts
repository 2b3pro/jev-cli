#!/usr/bin/env bun
// ============================================================================
// jev-sort: file scanned PDFs into folders, with jev deciding where each goes
// ============================================================================
//
// For each PDF in an inbox folder:
//   1. Read the first two pages (pdftotext, or OCR when the PDF is a bare scan)
//   2. Ask `jev choose` which category folder it belongs in
//   3. Confident: move it there (optionally under a year folder). Unsure: move it to a review folder.
//   4. Optionally rename it with Apple's on-device `fm` model, add a Finder tag, add a Finder comment,
//      or make it searchable.
//
// Nothing changes on disk without --apply. Run `jev-sort --help` for options.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { parseArgs } from "node:util";

// ----------------------------------------------------------------------------
// External tools
// ----------------------------------------------------------------------------

export interface RunResult {
  out: string;
  err: string;
  code: number;
}
export type Runner = (cmd: string[], stdin?: string) => Promise<RunResult>;

export const run: Runner = async (cmd, stdin) => {
  try {
    const proc = Bun.spawn(cmd, {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  } catch (error) {
    return { out: "", err: `${cmd[0]}: ${(error as Error).message}`, code: 127 };
  }
};

/** Turns a scanned PDF's first pages into text. Swap this to use a different OCR engine. */
export type Ocr = (pdf: string, runner: Runner) => Promise<string>;

/** Default OCR: ocrmypdf (tesseract) on pages 1-2, text to stdout, no PDF written. */
export const ocrmypdf: Ocr = async (pdf, runner) => {
  const r = await runner(["ocrmypdf", "--pages", "1-2", "--sidecar", "-", "--output-type", "none", "-q", pdf, "/dev/null"]);
  if (r.code !== 0) throw new Error(`ocrmypdf failed (exit ${r.code}): ${firstLine(r.err)}`);
  return r.out.replace(/\[OCR skipped on page\(s\) [^\]]*\]/g, "");
};

const firstLine = (s: string) => s.trim().split("\n").pop() ?? "";

// ----------------------------------------------------------------------------
// Categories
// ----------------------------------------------------------------------------

/** Folder names that are never categories: hidden, `_`-prefixed (inbox, review), and bare years. */
const NOT_A_CATEGORY = /^[._]|^\d{4}$/;
const SCANNER_NAME = /^[\d\s_.-]+$/;
const MAX_EXAMPLES = 15;
const MAX_DESCRIPTION = 700;

export function discoverCategories(into: string): string[] {
  return readdirSync(into, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !NOT_A_CATEGORY.test(d.name))
    .map((d) => d.name)
    .sort();
}

/** Names of documents already filed in a folder (newest first), as examples for jev. Scanner-default names are skipped. */
export function learnedExamples(folder: string, limit = MAX_EXAMPLES): string[] {
  const found: { name: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) walk(path, depth + 1);
      else if (entry.isFile() && /\.pdf$/i.test(entry.name)) {
        const name = entry.name.replace(/\.pdf$/i, "");
        if (!SCANNER_NAME.test(name)) found.push({ name, mtime: statSync(path).mtimeMs });
      }
    }
  };
  if (existsSync(folder)) walk(folder, 0);
  return [...new Set(found.sort((a, b) => b.mtime - a.mtime).map((f) => f.name))].slice(0, limit);
}

/** Combine a written description with learned examples into one choice description. */
export function describeCategory(written: string | undefined, examples: string[]): string | null {
  const parts = [written?.trim(), examples.length ? `Already filed here: ${examples.join("; ")}` : ""].filter(Boolean);
  return parts.length ? parts.join(". ").slice(0, MAX_DESCRIPTION) : null;
}

// ----------------------------------------------------------------------------
// Classification (jev)
// ----------------------------------------------------------------------------

const MAX_STATE_CHARS = 60_000;

export interface Classification {
  label: string;
  confidence: number;
  /** All options by probability, highest first. */
  ranked: [string, number][];
}

export async function classify(text: string, categories: Record<string, string | null>, runner: Runner): Promise<Classification> {
  const options = Object.entries(categories).map(([label, description]) => (description ? `${label}=${description}` : label));
  const r = await runner(
    ["jev", "choose", "--state", "-", "--", "Which folder should this document be filed in?", ...options],
    text.slice(0, MAX_STATE_CHARS),
  );
  if (r.code !== 0) throw new Error(`jev failed (exit ${r.code}): ${firstLine(r.err)}`);
  const answer = JSON.parse(r.out).answers.answer as { choice: string; confidence: number; probabilities: Record<string, number> };
  return {
    label: answer.choice,
    confidence: answer.confidence,
    ranked: Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]),
  };
}

// ----------------------------------------------------------------------------
// Naming (Apple's on-device fm model, checked against the text)
// ----------------------------------------------------------------------------

const NAME_SCHEMA = join(import.meta.dir, "fm-name.schema.json");
const MAX_NAME_INPUT = 6_000;
const MAX_NAME_LENGTH = 120;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Every full date written in the text, normalized to YYYY-MM-DD. */
export function datesIn(text: string, thisYear = new Date().getFullYear()): Set<string> {
  const found = new Set<string>();
  const pad = (n: number) => String(n).padStart(2, "0");
  const add = (y: number, m: number, d: number) => {
    if (y < 100) y += y <= (thisYear % 100) + 1 ? 2000 : 1900;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) found.add(`${y}-${pad(m)}-${pad(d)}`);
  };
  const month = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;

  for (const [, y, m, d] of text.matchAll(/\b(\d{4})[-./](\d{1,2})[-./](\d{1,2})\b/g)) add(+y!, +m!, +d!);
  for (const [, m, d, y] of text.matchAll(/\b(\d{1,2})[-./](\d{1,2})[-./](\d{4}|\d{2})\b/g)) add(+y!, +m!, +d!);
  for (const [, mon, d, y] of text.matchAll(/\b([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})\b/g)) {
    if (month(mon!)) add(+y!, month(mon!), +d!);
  }
  for (const [, d, mon, y] of text.matchAll(/\b(\d{1,2}) ([A-Za-z]{3,9})\.?,? (\d{4})\b/g)) {
    if (month(mon!)) add(+y!, month(mon!), +d!);
  }
  return found;
}

/**
 * Keep a model-claimed date only if the document backs it up:
 * the full date when it appears in the text, else just the year when that appears, else nothing.
 */
export function verifyDate(claimed: string | undefined, text: string): string {
  const m = /^(\d{4})(?:-\d{2}(?:-\d{2})?)?$/.exec(claimed?.trim() ?? "");
  if (!m) return "";
  if (claimed!.length === 10 && datesIn(text).has(claimed!)) return claimed!;
  return new RegExp(`\\b${m[1]}\\b`).test(text) ? m[1]! : "";
}

/** Clean OCR debris from a name part: odd symbols, stray letters, dangling punctuation, repeated words. */
export function cleanPart(s: string | undefined): string {
  const words = (s ?? "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} &'.()-]/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[-'.(]+|[-',(]+$/g, "").replace(/^\)+|\)+$/g, ""))
    .filter((w) => w.length > 1 || /^[aAI&\d]$/.test(w));
  return words.filter((w, i) => i === 0 || w.toLowerCase() !== words[i - 1]!.toLowerCase()).join(" ");
}

export function buildName(date: string, sender: string | undefined, title: string | undefined): string {
  let s = cleanPart(sender);
  let t = cleanPart(title);
  if (s && t.toLowerCase().includes(s.toLowerCase())) s = "";
  else if (t && s.toLowerCase().includes(t.toLowerCase())) t = "";
  let name = [date, s, t].filter(Boolean).join(" ");
  if (name.length > MAX_NAME_LENGTH) name = name.slice(0, MAX_NAME_LENGTH).replace(/\s+\S*$/, "");
  return name.trim();
}

export interface NameProposal {
  /** New base name without extension, or undefined to keep the original. */
  base?: string;
  /** The verified date part ("", "YYYY" or "YYYY-MM-DD"). */
  date: string;
  note: string;
}

export async function proposeName(text: string, runner: Runner): Promise<NameProposal> {
  const r = await runner([
    "fm", "respond", "--schema", NAME_SCHEMA, "--greedy", "--no-stream",
    "-i", "Extract filing details from the document. Use only information printed in it.",
    "--text", text.slice(0, MAX_NAME_INPUT),
    "Name this document.",
  ]);
  if (r.code !== 0) return { date: "", note: `fm failed: ${firstLine(r.err)}` };

  let fields: { date?: string; sender?: string; title?: string };
  try {
    fields = JSON.parse(r.out);
  } catch {
    return { date: "", note: "fm returned no usable name" };
  }
  const date = verifyDate(fields.date, text);
  const base = buildName(date, fields.sender, fields.title);
  if (!base || base === date) return { date, note: "no name found" };

  const gate = await runner(
    ["jev", "ask", "Does this proposed filename contain garbled OCR fragments or nonsense words?",
      "--yes", "Contains random letter strings or broken fragments that are not real words or names",
      "--no", "Every word is a real word, name, number or abbreviation", "--raw", "--state", "-"],
    base,
  );
  const p = Number(gate.out.trim());
  if (gate.code !== 0 || !Number.isFinite(p)) return { date, note: "could not check the name; keeping the original" };
  if (p >= 0.5) return { date, note: `proposed name looked garbled (${p.toFixed(2)}); keeping the original` };

  const dateNote = !fields.date ? "no date" : date === fields.date ? "date verified" : date ? "year only" : "date not in text, dropped";
  return { base, date, note: dateNote };
}

// ----------------------------------------------------------------------------
// macOS Finder metadata
// ----------------------------------------------------------------------------

const ADD_TAG_JXA = `
ObjC.import('Foundation');
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const out = Ref();
  url.getResourceValueForKeyError(out, $.NSURLTagNamesKey, null);
  const tags = out[0] && !out[0].isNil() ? ObjC.deepUnwrap(out[0]) : [];
  if (!tags.includes(argv[1])) tags.push(argv[1]);
  if (!url.setResourceValueForKeyError($(tags), $.NSURLTagNamesKey, null)) throw new Error('could not set tags');
}`;

/** Add a Finder tag, keeping any tags already on the file. */
export async function addFinderTag(path: string, tag: string, runner: Runner): Promise<void> {
  const r = await runner(["osascript", "-l", "JavaScript", "-e", ADD_TAG_JXA, path, tag]);
  if (r.code !== 0) throw new Error(`could not tag: ${firstLine(r.err)}`);
}

/** Append to the Finder comment. Must go through Finder: a metadata-only write is invisible in Get Info. */
export async function addFinderComment(path: string, text: string, runner: Runner): Promise<void> {
  const r = await runner([
    "osascript",
    "-e", "on run argv",
    "-e", "set f to (POSIX file (item 1 of argv)) as alias",
    "-e", 'tell application "Finder"',
    "-e", "set c to comment of f",
    "-e", 'if c is "" then',
    "-e", "set comment of f to (item 2 of argv)",
    "-e", "else",
    "-e", "set comment of f to c & return & (item 2 of argv)",
    "-e", "end if",
    "-e", "end tell",
    "-e", "end run",
    path, text,
  ]);
  if (r.code !== 0) throw new Error(`could not comment: ${firstLine(r.err)}`);
}

// ----------------------------------------------------------------------------
// Files
// ----------------------------------------------------------------------------

/** `dir/name.pdf`, or `dir/name (2).pdf` etc. when taken on disk or by an earlier plan entry. Never overwrites. */
export function uniquePath(dir: string, base: string, ext: string, reserved: Set<string>): string {
  for (let n = 1; ; n++) {
    const path = join(dir, n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`);
    if (!existsSync(path) && !reserved.has(path)) {
      reserved.add(path);
      return path;
    }
  }
}

/** Move a file without overwriting, falling back to copy + delete across volumes. */
export function moveFile(from: string, to: string): void {
  if (existsSync(to)) throw new Error(`refusing to overwrite ${to}`);
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyFileSync(from, to);
    if (statSync(to).size !== statSync(from).size) {
      unlinkSync(to);
      throw new Error(`copy to ${to} was incomplete`);
    }
    unlinkSync(from);
  }
}

/** Add an OCR text layer to a scanned PDF in place (only pages without text are touched). */
async function makeSearchable(pdf: string, runner: Runner): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "jev-sort-"));
  try {
    const out = join(work, "searchable.pdf");
    const r = await runner(["ocrmypdf", "--skip-text", "--output-type", "pdf", "-q", pdf, out]);
    if (r.code !== 0) throw new Error(`ocrmypdf failed (exit ${r.code}): ${firstLine(r.err)}`);
    copyFileSync(out, pdf);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const today = () => new Intl.DateTimeFormat("en-CA").format(new Date());
const pct = (p: number) => `${Math.round(p * 100)}%`;

// ----------------------------------------------------------------------------
// Plan and apply
// ----------------------------------------------------------------------------

export interface Options {
  inbox: string;
  into: string;
  reviewDir: string;
  categories: Record<string, string | null>;
  min: number;
  byYear: boolean;
  rename: boolean;
  tag: boolean;
  comment: boolean;
  searchable: boolean;
  apply: boolean;
}

export interface PlanItem {
  file: string;
  text_source?: "text" | "ocr";
  action: "file" | "review" | "error";
  label?: string;
  confidence?: number;
  ranked?: [string, number][];
  dest?: string;
  name_note?: string;
  error?: string;
  applied?: boolean;
}

export interface Deps {
  runner: Runner;
  ocr: Ocr;
  log: (line: string) => void;
}

async function extractText(pdf: string, deps: Deps): Promise<{ text: string; source: "text" | "ocr" }> {
  const r = await deps.runner(["pdftotext", "-l", "2", pdf, "-"]);
  if (r.code === 0 && r.out.replace(/\s/g, "").length >= 20) return { text: r.out, source: "text" };
  return { text: await deps.ocr(pdf, deps.runner), source: "ocr" };
}

export async function planOne(pdf: string, opts: Options, deps: Deps, reserved: Set<string>): Promise<PlanItem> {
  const item: PlanItem = { file: basename(pdf), action: "error" };
  try {
    const { text, source } = await extractText(pdf, deps);
    item.text_source = source;
    if (text.replace(/\s/g, "").length < 20) {
      item.action = "review";
      item.name_note = "no readable text";
      item.dest = uniquePath(opts.reviewDir, basename(pdf, extname(pdf)), extname(pdf).toLowerCase() || ".pdf", reserved);
      return item;
    }

    const c = await classify(text, opts.categories, deps.runner);
    item.label = c.label;
    item.confidence = c.confidence;
    item.ranked = c.ranked.slice(0, 3);
    item.action = c.confidence >= opts.min ? "file" : "review";

    let base = basename(pdf, extname(pdf));
    let year = "";
    if (opts.rename) {
      const proposal = await proposeName(text, deps.runner);
      item.name_note = proposal.note;
      if (proposal.base) base = proposal.base;
      year = proposal.date.slice(0, 4);
    }
    if (!year) year = String(statSync(pdf).birthtime.getFullYear());

    const dir = item.action === "file" ? join(opts.into, c.label, opts.byYear ? year : "") : opts.reviewDir;
    item.dest = uniquePath(dir, base, extname(pdf).toLowerCase() || ".pdf", reserved);
  } catch (error) {
    item.action = "error";
    item.error = (error as Error).message;
  }
  return item;
}

export async function applyOne(pdf: string, item: PlanItem, opts: Options, deps: Deps): Promise<void> {
  if (item.action === "error" || !item.dest) return;
  try {
    if (opts.searchable && item.text_source === "ocr") await makeSearchable(pdf, deps.runner);
    mkdirSync(dirname(item.dest), { recursive: true });
    moveFile(pdf, item.dest);
    if (opts.tag && item.action === "file") await addFinderTag(item.dest, item.label!, deps.runner);
    if (opts.comment) {
      const next = item.ranked?.[1];
      const note =
        item.action === "file"
          ? `jev-sort ${today()}: ${item.label} (${pct(item.confidence!)})${next ? `; next ${next[0]} ${pct(next[1])}` : ""}`
          : `jev-sort ${today()}: unsure; best guesses ${(item.ranked ?? []).map(([l, p]) => `${l} ${pct(p)}`).join(", ")}`;
      await addFinderComment(item.dest, note, deps.runner);
    }
    item.applied = true;
  } catch (error) {
    item.error = (error as Error).message;
    item.action = "error";
  }
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

const HELP = `jev-sort: file scanned PDFs into folders, with jev deciding where each goes

USAGE
  jev-sort <inbox> --into <dir> [options]

  Categories are the subfolders of --into. Folders starting with "." or "_", and folders
  named like a year (2024), are skipped. Each category is described to jev with the names
  of documents already filed in it, plus any description you give with --describe.

OPTIONS
  --into <dir>          Folder whose subfolders are the categories (required)
  --categories <a,b>    Use only these subfolders as categories
  --describe <file>     YAML or JSON map of category: description, for folders with few examples
  --review-dir <dir>    Where unsure files go (default: <into>/_Review)
  --min <p>             Confidence needed to file, 0-1 (default 0.6)
  --by-year             File into <category>/<year>/, using the document's year when verified,
                        else the file's creation year
  --rename              Name files "<date> <sender> <title>" using Apple's on-device fm model.
                        Dates are kept only if printed in the document; garbled names are rejected.
  --tag                 Add the category as a Finder tag (macOS)
  --comment             Add jev's decision and confidence to the Finder comment (macOS)
  --searchable          Add an OCR text layer to scanned PDFs before filing (modifies the PDF)
  --apply               Do it. Without this, jev-sort only prints the plan.
  --json                Print one JSON object per file instead of a table
  -h, --help            Show this help

REQUIRES
  jev and pdftotext (poppler) on PATH; ocrmypdf for scanned PDFs and --searchable;
  fm (macOS with Apple Intelligence) for --rename.

EXAMPLES
  jev-sort ~/Scans/Inbox --into ~/Documents/Filed
  jev-sort ~/Scans/Inbox --into ~/Documents/Filed --by-year --rename --tag --apply`;

function loadDescriptions(path: string | undefined): Record<string, string> {
  if (!path) return {};
  const text = readFileSync(path, "utf8");
  const doc = path.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text);
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error(`${path} must be a map of category: description`);
  return Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, String(v ?? "")]));
}

function displayPath(path: string, opts: Options): string {
  const rel = relative(opts.into, path);
  return rel.startsWith("..") ? path : rel;
}

function formatItem(item: PlanItem, opts: Options): string {
  const conf = item.confidence === undefined ? "" : ` (${item.confidence.toFixed(2)})`;
  if (item.action === "error") return `  error   ${item.file}: ${item.error}`;
  const detail =
    item.action === "review" && item.ranked
      ? `  confidence ${item.confidence!.toFixed(2)}; odds: ${item.ranked.map(([l, p]) => `${l} ${p.toFixed(2)}`).join(", ")}`
      : conf;
  const note = item.name_note ? `  [${item.name_note}]` : "";
  return `  ${item.action.padEnd(7)} ${item.file}\n          → ${displayPath(item.dest!, opts)}${detail}${note}`;
}

export async function main(argv: string[], deps: Deps = { runner: run, ocr: ocrmypdf, log: (l) => console.error(l) }, defaults: Partial<Record<string, string | boolean>> = {}): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      into: { type: "string" },
      categories: { type: "string" },
      describe: { type: "string" },
      "review-dir": { type: "string" },
      min: { type: "string" },
      "by-year": { type: "boolean" },
      rename: { type: "boolean" },
      tag: { type: "boolean" },
      comment: { type: "boolean" },
      searchable: { type: "boolean" },
      apply: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const v = { ...defaults, ...Object.fromEntries(Object.entries(values).filter(([, x]) => x !== undefined)) } as Record<string, string | boolean | undefined>;

  if (v.help) {
    console.log(HELP);
    return 0;
  }
  const inbox = positionals[0] ?? (v.inbox as string | undefined);
  const into = v.into as string | undefined;
  if (!inbox || !into) {
    deps.log("jev-sort: need an inbox folder and --into <dir>. Run 'jev-sort --help'.");
    return 2;
  }
  for (const dir of [inbox, into]) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      deps.log(`jev-sort: not a folder: ${dir}`);
      return 2;
    }
  }
  if ((v.tag || v.comment) && process.platform !== "darwin") {
    deps.log("jev-sort: --tag and --comment need macOS");
    return 2;
  }
  if (v.rename && (await deps.runner(["fm", "available"])).code !== 0) {
    deps.log("jev-sort: --rename needs Apple's fm tool with Apple Intelligence available");
    return 2;
  }

  const min = Number(v.min ?? 0.6);
  if (!(min >= 0 && min <= 1)) {
    deps.log("jev-sort: --min must be between 0 and 1");
    return 2;
  }

  const discovered = discoverCategories(into);
  const chosen = v.categories ? String(v.categories).split(",").map((s) => s.trim()).filter(Boolean) : discovered;
  const missing = chosen.filter((c) => !existsSync(join(into, c)));
  if (missing.length) {
    deps.log(`jev-sort: no such category folder in ${into}: ${missing.join(", ")}`);
    return 2;
  }
  if (chosen.length < 1) {
    deps.log(`jev-sort: no category folders found in ${into}`);
    return 2;
  }
  let written: Record<string, string>;
  try {
    written = loadDescriptions(v.describe as string | undefined);
  } catch (error) {
    deps.log(`jev-sort: cannot read --describe file: ${(error as Error).message}`);
    return 2;
  }
  const categories = Object.fromEntries(chosen.map((c) => [c, describeCategory(written[c], learnedExamples(join(into, c)))]));

  const opts: Options = {
    inbox,
    into,
    reviewDir: (v["review-dir"] as string | undefined) ?? join(into, "_Review"),
    categories,
    min,
    byYear: Boolean(v["by-year"]),
    rename: Boolean(v.rename),
    tag: Boolean(v.tag),
    comment: Boolean(v.comment),
    searchable: Boolean(v.searchable),
    apply: Boolean(v.apply),
  };

  const pdfs = readdirSync(inbox)
    .filter((f) => !f.startsWith(".") && /\.pdf$/i.test(f))
    .sort()
    .map((f) => join(inbox, f));
  if (pdfs.length === 0) {
    deps.log(`jev-sort: no PDFs in ${inbox}`);
    return 0;
  }

  deps.log(`jev-sort: ${pdfs.length} PDFs, categories: ${chosen.join(", ")}${opts.apply ? "" : " (dry run)"}`);
  const reserved = new Set<string>();
  const items: PlanItem[] = [];
  for (const [i, pdf] of pdfs.entries()) {
    deps.log(`  [${i + 1}/${pdfs.length}] ${basename(pdf)}`);
    const item = await planOne(pdf, opts, deps, reserved);
    if (opts.apply) await applyOne(pdf, item, opts, deps);
    items.push(item);
    console.log(v.json ? JSON.stringify(item) : formatItem(item, opts));
  }

  const count = (a: PlanItem["action"]) => items.filter((x) => x.action === a).length;
  deps.log(
    `\n${count("file")} to file, ${count("review")} to review, ${count("error")} errors.` +
      (opts.apply ? "" : " Dry run: nothing changed. Add --apply to do it."),
  );
  return count("error") > 0 ? 2 : 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
