// ============================================================================
// API client, error reporting, and optional structured logging
// ============================================================================

import { existsSync } from "node:fs";
import { join } from "node:path";
import { APIConnectionError, APIError, APITimeoutError, TypeSafeClient, TypeSafeError } from "@typesafe-ai/sdk";
import { UsageError } from "./args.ts";
import type { Io } from "./io.ts";

export const KEY_NAME = "TYPESAFE_API_KEY";

/** API key from the environment, then from the macOS Keychain (service `TYPESAFE_API_KEY`). */
export function resolveApiKey(io: Io): string | undefined {
  return io.env[KEY_NAME]?.trim() || io.keychain(KEY_NAME);
}

export interface ClientOptions {
  timeout?: number;
  retries?: number;
  verbose: boolean;
}

export function createClient(io: Io, options: ClientOptions): TypeSafeClient {
  const apiKey = resolveApiKey(io);
  if (!apiKey) {
    throw new UsageError(
      `No API key. Set ${KEY_NAME}, or on macOS store it with:\n` +
        `  security add-generic-password -s ${KEY_NAME} -a "$USER" -w <key>\n` +
        "Get a key at https://console.typesafe.ai/keys",
    );
  }
  return new TypeSafeClient({
    apiKey,
    baseURL: io.env.TYPESAFE_BASE_URL,
    defaultModel: io.env.TYPESAFE_DEFAULT_MODEL,
    logLevel: options.verbose ? "info" : undefined,
    timeout: options.timeout,
    retry: options.retries === undefined ? undefined : { maxRetries: options.retries },
    fetch: io.fetch,
  });
}

/** Model a request will use when none is given: the SDK's own resolution order. */
export function defaultModel(io: Io): string {
  return io.env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-latest";
}

// ----------------------------------------------------------------------------
// Errors
// ----------------------------------------------------------------------------

export interface ErrorSummary {
  message: string;
  status?: number;
  request_id?: string;
}

/** Turn any thrown value into a one-line, actionable message. */
export function describeError(error: unknown): ErrorSummary {
  if (error instanceof APIError) {
    const detail = apiDetail(error.body).replace(/[.\s]+$/, "");
    const hint =
      error.status === 401 || error.status === 403
        ? ` Check ${KEY_NAME}.`
        : error.status === 429
          ? " Rate limited; lower --concurrency or retry later."
          : error.status === 529
            ? " The API is overloaded; retry later."
            : "";
    return {
      message: `API error ${error.status}${detail ? `: ${detail}` : ""}.${hint}`,
      status: error.status,
      request_id: error.requestId,
    };
  }
  if (error instanceof APITimeoutError) {
    return { message: `Request timed out after ${error.timeoutMs} ms (raise --timeout)` };
  }
  if (error instanceof APIConnectionError) {
    return { message: `Cannot reach the TypeSafe API: ${error.message}` };
  }
  if (error instanceof TypeSafeError || error instanceof UsageError) {
    return { message: error.message };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

/** Pull a readable message out of FastAPI-style error bodies. */
function apiDetail(body: unknown): string {
  if (typeof body === "string") return body.trim();
  if (typeof body !== "object" || body === null) return "";
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item: { loc?: unknown[]; msg?: string }) => [item.loc?.join("."), item.msg].filter(Boolean).join(": "))
      .join("; ");
  }
  if (typeof detail === "object" && detail !== null && "message" in detail) {
    return String((detail as { message: unknown }).message);
  }
  return JSON.stringify(body);
}

// ----------------------------------------------------------------------------
// Optional structured logging
// ----------------------------------------------------------------------------

interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>, error?: unknown): void;
}

const silent: Logger = { info() {}, error() {} };

/**
 * When `$PAI_DIR` points at a PAI install, operational events go to its structured
 * logger so failures are visible to its monitoring. Otherwise logging is a no-op.
 * Loaded lazily, so the happy path of a one-shot call pays nothing.
 */
export async function getLogger(io: Io): Promise<Logger> {
  const paiDir = io.env.PAI_DIR;
  if (!paiDir) return silent;
  const path = join(paiDir, "Infrastructure", "Logger", "logger.ts");
  if (!existsSync(path)) return silent;
  try {
    const mod = (await import(path)) as { createLogger(options: { source: string }): Logger };
    return mod.createLogger({ source: "CLI:jev" });
  } catch {
    return silent;
  }
}
