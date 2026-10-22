/**
 * Telemetry primitives. Pure: no `fetch`, no environment, no globals.
 *
 * The split between this file and `transport.ts` is what makes the package
 * usable from a transactional backend mutation, which cannot make network
 * calls at all. The code that *decides what to report* has to be callable
 * from there; only the code that *transmits* needs a runtime with `fetch`.
 * Without the split a mutation has no option but to swallow its errors and
 * hope something downstream notices.
 *
 * Being pure also makes all of it host-testable, which matters more than it
 * sounds: redaction is the one thing here that fails silently and expensively.
 */

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

export type TelemetrySeverity = "info" | "warn" | "error" | "fatal";

/** errorLogs only models three levels; `fatal` collapses into `error` there. */
export function toLogSeverity(
  level: TelemetrySeverity,
): "info" | "warn" | "error" {
  return level === "fatal" ? "error" : level;
}

/** Sentry's level vocabulary. */
export function toSentryLevel(level: TelemetrySeverity): string {
  return level;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Keys whose values never leave the deployment.
 *
 * Matched as substrings against the lowercased key, so `driverEmail`,
 * `email_address` and `contactEmail` are all caught by `email`. Substring
 * matching over-redacts by design — a lost debugging field costs a follow-up
 * question, a leaked driver phone number costs a privacy incident.
 */
const SENSITIVE_KEY_PARTS = [
  "address",
  "apikey",
  "auth",
  "bearer",
  "birth",
  "card",
  "cookie",
  "credential",
  "dob",
  "email",
  "iban",
  "jwt",
  "latitude",
  "licence",
  "license",
  "longitude",
  "name",
  "passport",
  "password",
  "phone",
  "pin",
  "private",
  "routingnumber",
  "secret",
  "session",
  "signature",
  "ssn",
  "taxid",
  "telephone",
  "token",
] as const;

/** These compounds contain a sensitive part but never hold personal data. */
const KEY_ALLOWLIST = new Set([
  "codename",
  "filename",
  "hostname",
  "tablename",
  "eventname",
  "monitorname",
]);

/**
 * Separators are stripped before matching, so `x-api-key`, `x_api_key` and
 * `xApiKey` all reduce to the same thing. Header names in particular arrive
 * hyphenated, and a list written in one convention would silently miss them.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (KEY_ALLOWLIST.has(normalized)) return false;
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

const MAX_STRING = 512;
const MAX_DEPTH = 4;
const MAX_ARRAY = 20;
const MAX_KEYS = 40;

/**
 * Recursively strip sensitive values and bound the size of what is left.
 *
 * Unknown shapes reach this from `catch (err)` blocks all over the codebase,
 * so it must never throw: a redactor that panics on a cyclic object turns a
 * reportable error into an unreportable one.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") {
    return "[unserializable]";
  }

  if (depth >= MAX_DEPTH) return "[depth limit]";

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
    return value.length > MAX_ARRAY
      ? [...head, `[+${value.length - MAX_ARRAY} more]`]
      : head;
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let seen = 0;
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (seen >= MAX_KEYS) {
        out["[truncated]"] = true;
        break;
      }
      seen += 1;
      out[key] = isSensitiveKey(key) ? "[redacted]" : redact(entry, depth + 1);
    }
    return out;
  }

  return "[unserializable]";
}

export function redactRecord(
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!input) return undefined;
  return redact(input) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Error normalisation
// ---------------------------------------------------------------------------

export type NormalizedError = {
  type: string;
  message: string;
  stack?: string;
};

/**
 * Turn whatever was thrown into something reportable.
 *
 * `throw "nope"` and `throw { code: 500 }` are both legal and both appear in
 * dependencies, so this cannot assume an `Error`.
 */
export function normalizeError(err: unknown): NormalizedError {
  if (err instanceof Error) {
    return {
      type: err.name || "Error",
      message: String(err.message ?? "").slice(0, MAX_STRING) || "(no message)",
      stack: typeof err.stack === "string" ? err.stack : undefined,
    };
  }

  if (typeof err === "string") {
    return { type: "ThrownString", message: err.slice(0, MAX_STRING) };
  }

  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    const message =
      typeof record.message === "string"
        ? record.message
        : safeStringify(redact(record));
    return {
      type: typeof record.name === "string" ? record.name : "ThrownObject",
      message: message.slice(0, MAX_STRING) || "(no message)",
      stack: typeof record.stack === "string" ? record.stack : undefined,
    };
  }

  return { type: "ThrownValue", message: String(err).slice(0, MAX_STRING) };
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

// ---------------------------------------------------------------------------
// Stack parsing
// ---------------------------------------------------------------------------

export type StackFrame = {
  function?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
};

const FRAME_WITH_FN = /^\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)\s*$/;
const FRAME_BARE = /^\s*at\s+(.+?):(\d+):(\d+)\s*$/;

/**
 * Parse a V8 stack into Sentry frames, innermost last.
 *
 * Sentry groups on the frame list, so shipping the raw string instead would
 * collapse every error from a given function into one issue regardless of
 * where it actually came from.
 */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];

  const frames: StackFrame[] = [];
  for (const line of stack.split("\n")) {
    const withFn = FRAME_WITH_FN.exec(line);
    if (withFn) {
      frames.push({
        function: withFn[1],
        filename: withFn[2],
        lineno: Number(withFn[3]),
        colno: Number(withFn[4]),
        in_app: !withFn[2].includes("node_modules"),
      });
      continue;
    }

    const bare = FRAME_BARE.exec(line);
    if (bare) {
      frames.push({
        filename: bare[1],
        lineno: Number(bare[2]),
        colno: Number(bare[3]),
        in_app: !bare[1].includes("node_modules"),
      });
    }
  }

  // V8 lists the throw site first; Sentry expects it last.
  return frames.reverse();
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const HEX = "0123456789abcdef";

function hex(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += HEX[Math.floor(Math.random() * 16)];
  }
  return out;
}

/** Sentry event ids are 32 lowercase hex characters, no dashes. */
export function eventId(): string {
  return hex(32);
}

/** W3C trace id: 32 hex characters. Shared with PostHog as `trace_id`. */
export function traceId(): string {
  return hex(32);
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/**
 * Group by the thing that broke, not by the message.
 *
 * Messages here routinely embed ids ("load abc123 has no stops"), which would
 * otherwise open a fresh Sentry issue per record and bury the pattern.
 */
export function fingerprintFor(args: {
  code: string;
  fn?: string;
  errorType?: string;
}): string[] {
  const parts = [args.code];
  if (args.fn) parts.push(args.fn);
  if (args.errorType) parts.push(args.errorType);
  return parts;
}
