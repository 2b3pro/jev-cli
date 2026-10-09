// ============================================================================
// Questions: built from command-line arguments or loaded from preset files
// ============================================================================

import { homedir } from "node:os";
import { join } from "node:path";
import { choice, noul, score, type ChoiceCriteria, type Question, type Questions, type ScoreCriteria } from "@typesafe-ai/sdk";
import { UsageError } from "./args.ts";
import type { Io } from "./io.ts";

const MAX_CHOICES = 255;
const MAX_LEVELS = 10;

/** `jev ask` / `jev gate`: a yes/no question with optional outcome descriptions. */
export function yesNoQuestion(instructions: string, yes?: string, no?: string): Question {
  const criteria = yes === undefined && no === undefined ? undefined : { true: yes ?? null, false: no ?? null };
  return noul(instructions, criteria);
}

/** `jev choose`: options as `label` or `label=description`. */
export function choiceQuestion(instructions: string, options: string[]): Question {
  if (options.length < 2) throw new UsageError("choose needs at least two options, e.g. billing technical sales");
  if (options.length > MAX_CHOICES) throw new UsageError(`choose accepts at most ${MAX_CHOICES} options`);

  const criteria: ChoiceCriteria = {};
  for (const option of options) {
    const eq = option.indexOf("=");
    const label = (eq === -1 ? option : option.slice(0, eq)).trim();
    const description = eq === -1 ? null : option.slice(eq + 1).trim() || null;
    if (label === "") throw new UsageError(`Option '${option}' has an empty label`);
    if (Object.hasOwn(criteria, label)) throw new UsageError(`Duplicate option label '${label}'`);
    criteria[label] = description;
  }
  return choice(instructions, criteria);
}

/** `jev score`: ordered level descriptions, lowest first. */
export function scoreQuestion(instructions: string, levels: string[]): Question {
  if (levels.length < 2) throw new UsageError("score needs at least two levels, lowest first, e.g. low medium high");
  if (levels.length > MAX_LEVELS) throw new UsageError(`score accepts at most ${MAX_LEVELS} levels`);
  return score(instructions, levels as unknown as ScoreCriteria);
}

// ----------------------------------------------------------------------------
// Presets
// ----------------------------------------------------------------------------

export interface Preset {
  /** Where the preset was loaded from. */
  source: string;
  model?: string;
  questions: Questions;
}

const PRESET_EXTENSIONS = [".yaml", ".yml", ".json"];
const QUESTION_TYPES = new Set(["noul", "choice", "score"]);

/** `$JEV_PRESETS_DIR`, else `$XDG_CONFIG_HOME/jev/presets`, else `~/.config/jev/presets`. */
export function presetsDir(env: Io["env"]): string {
  if (env.JEV_PRESETS_DIR) return env.JEV_PRESETS_DIR;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "jev", "presets");
}

function looksLikePath(ref: string): boolean {
  return ref.includes("/") || PRESET_EXTENSIONS.some((ext) => ref.endsWith(ext));
}

/** Load a preset by file path, or by name from the presets directory. */
export async function loadPreset(ref: string, io: Io): Promise<Preset> {
  const candidates = looksLikePath(ref)
    ? [ref]
    : PRESET_EXTENSIONS.map((ext) => join(presetsDir(io.env), `${ref}${ext}`));

  for (const path of candidates) {
    const text = await io.readFile(path);
    if (text !== undefined) return parsePreset(text, path);
  }

  const where = looksLikePath(ref) ? ref : `${presetsDir(io.env)}/${ref}.{yaml,yml,json}`;
  throw new UsageError(`Preset not found: ${where}`);
}

/** Parse and sanity-check preset text. Deeper validation is left to the API. */
export function parsePreset(text: string, source: string): Preset {
  let doc: unknown;
  try {
    doc = source.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text);
  } catch (error) {
    throw new UsageError(`Cannot parse preset ${source}: ${(error as Error).message}`);
  }

  if (!isRecord(doc) || !isRecord(doc.questions) || Object.keys(doc.questions).length === 0) {
    throw new UsageError(`Preset ${source} needs a non-empty 'questions' map`);
  }
  if (doc.model !== undefined && typeof doc.model !== "string") {
    throw new UsageError(`Preset ${source}: 'model' must be a string`);
  }

  for (const [name, question] of Object.entries(doc.questions)) {
    if (!isRecord(question) || typeof question.type !== "string" || !QUESTION_TYPES.has(question.type)) {
      throw new UsageError(`Preset ${source}: question '${name}' needs type noul, choice or score`);
    }
    if (question.type === "score" && !(Array.isArray(question.criteria) && question.criteria.length >= 2)) {
      throw new UsageError(`Preset ${source}: score question '${name}' needs a criteria list of at least two levels`);
    }
    if (question.type === "choice" && !isRecord(question.criteria)) {
      throw new UsageError(`Preset ${source}: choice question '${name}' needs a criteria map of label: description`);
    }
  }

  return { source, model: doc.model, questions: doc.questions as unknown as Questions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
