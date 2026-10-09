// ============================================================================
// Argument parsing (no framework: flat flags, positional arguments)
// ============================================================================

/** Bad input from the caller. Always exits 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

const VALUE_FLAGS = [
  "state",
  "model",
  "name",
  "yes",
  "no",
  "min",
  "max",
  "field",
  "concurrency",
  "timeout",
  "retries",
] as const;

export type ValueFlag = (typeof VALUE_FLAGS)[number];

const BOOLEAN_FLAGS = {
  raw: "raw",
  quiet: "quiet",
  q: "quiet",
  "dry-run": "dryRun",
  verbose: "verbose",
  help: "help",
  h: "help",
  version: "version",
  v: "version",
} as const;

type BooleanFlag = (typeof BOOLEAN_FLAGS)[keyof typeof BOOLEAN_FLAGS];

export interface ParsedArgs extends Record<BooleanFlag, boolean> {
  command: string | undefined;
  positionals: string[];
  values: Partial<Record<ValueFlag, string>>;
}

function isValueFlag(name: string): name is ValueFlag {
  return (VALUE_FLAGS as readonly string[]).includes(name);
}

function isBooleanFlag(name: string): name is keyof typeof BOOLEAN_FLAGS {
  return Object.hasOwn(BOOLEAN_FLAGS, name);
}

/**
 * Parse argv into a command, positionals and flags.
 * Accepts `--flag value`, `--flag=value`, short booleans (`-q`), and `--` to end flags.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: undefined,
    positionals: [],
    values: {},
    raw: false,
    quiet: false,
    dryRun: false,
    verbose: false,
    help: false,
    version: false,
  };
  const rest: string[] = [];
  let flagsEnded = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (flagsEnded || arg === "-" || !arg.startsWith("-")) {
      rest.push(arg);
      continue;
    }
    if (arg === "--") {
      flagsEnded = true;
      continue;
    }

    const body = arg.replace(/^--?/, "");
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? undefined : body.slice(eq + 1);

    if (isBooleanFlag(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} does not take a value`);
      parsed[BOOLEAN_FLAGS[name]] = true;
    } else if (isValueFlag(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      parsed.values[name] = value;
    } else {
      throw new UsageError(`Unknown option '${arg}'`);
    }
  }

  parsed.command = rest.shift();
  parsed.positionals = rest;
  return parsed;
}

/** Parse a numeric flag, enforcing bounds and (optionally) integer values. */
export function numberFlag(
  name: string,
  value: string | undefined,
  { min, max, integer = false }: { min: number; max: number; integer?: boolean },
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) {
    const kind = integer ? "an integer" : "a number";
    throw new UsageError(`--${name} must be ${kind} from ${min} to ${max} (got '${value}')`);
  }
  return n;
}
