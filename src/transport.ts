/**
 * Wire formats for Sentry and PostHog, spoken over plain `fetch`.
 *
 * Configuration is passed in rather than read from `process.env`. The callers
 * genuinely disagree about where it lives — the backend has deployment env
 * vars, the web server has its host's, the routing service has its own
 * prefixed set — and a module that guesses would be wrong for two of the
 * three. Passing it also makes both senders testable without touching the
 * environment.
 */

import {
  eventId,
  fingerprintFor,
  parseStack,
  redactRecord,
  toSentryLevel,
  type NormalizedError,
  type TelemetrySeverity,
} from "./core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type SentryConfig = {
  /** `https://<publicKey>@<host>/<projectId>`. Absent disables sending. */
  dsn: string | undefined;
  environment: string;
  release?: string;
  /** Tagged on every event, so one Sentry project can hold several services. */
  service: string;
};

export type PostHogConfig = {
  /** Project write key. Absent disables sending. */
  apiKey: string | undefined;
  host?: string;
  environment: string;
  service: string;
};

export type SendResult = {
  ok: boolean;
  /** Not configured. Distinct from a delivery failure, deliberately. */
  skipped?: true;
  status?: number;
  error?: string;
};

export type SentryTarget = {
  envelopeUrl: string;
  publicKey: string;
};

/**
 * Parse a DSN into the envelope endpoint.
 *
 * DSN form: `https://<publicKey>@<host>/<projectId>`
 * Envelope: `https://<host>/api/<projectId>/envelope/`
 */
export function parseSentryDsn(dsn: string | undefined): SentryTarget | null {
  const trimmed = dsn?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    const projectId = url.pathname.replace(/^\/+/, "").split("/").pop();
    if (!url.username || !projectId) return null;

    return {
      envelopeUrl: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
      publicKey: url.username,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sentry
// ---------------------------------------------------------------------------

export type SentryReport = {
  level: TelemetrySeverity;
  /** Stable grouping key. Must not embed ids — it is the fingerprint. */
  code: string;
  error: NormalizedError;
  /** Function or route this came from; becomes the Sentry transaction. */
  fn?: string;
  orgId?: string;
  userId?: string;
  category?: string;
  traceId?: string;
  durationMs?: number;
  tags?: Record<string, string | number | boolean | undefined | null>;
  extra?: Record<string, unknown>;
};

function buildSentryEvent(config: SentryConfig, report: SentryReport) {
  const frames = parseStack(report.error.stack);

  const tags: Record<string, string> = {
    service: config.service,
    error_code: report.code,
  };
  if (report.fn) tags.function = report.fn;
  if (report.category) tags.category = report.category;
  // An opaque identifier, not customer data — and without it a report cannot
  // be traced back to the tenant that hit it.
  if (report.orgId) tags.org_id = report.orgId;
  if (report.traceId) tags.trace_id = report.traceId;

  for (const [key, value] of Object.entries(report.tags ?? {})) {
    if (value === undefined || value === null) continue;
    tags[key] = String(value).slice(0, 200);
  }

  return {
    event_id: eventId(),
    timestamp: Date.now() / 1000,
    platform: "node",
    logger: config.service,
    level: toSentryLevel(report.level),
    environment: config.environment,
    release: config.release,
    server_name: config.service,
    transaction: report.fn,
    fingerprint: fingerprintFor({
      code: report.code,
      fn: report.fn,
      errorType: report.error.type,
    }),
    tags,
    // Sentry's `user` field is indexed and searchable; the id is all that goes
    // in it, never an email or a name.
    user: report.userId ? { id: report.userId } : undefined,
    contexts: report.traceId
      ? {
          trace: {
            trace_id: report.traceId,
            span_id: report.traceId.slice(0, 16),
          },
        }
      : undefined,
    extra: {
      ...(redactRecord(report.extra) ?? {}),
      ...(report.durationMs !== undefined
        ? { duration_ms: report.durationMs }
        : {}),
    },
    exception: {
      values: [
        {
          type: report.error.type,
          value: report.error.message,
          stacktrace: frames.length ? { frames } : undefined,
        },
      ],
    },
  };
}

/** Sentry envelopes are newline-delimited JSON: header, item header, payload. */
function encodeEnvelope(event: ReturnType<typeof buildSentryEvent>): string {
  const header = JSON.stringify({
    event_id: event.event_id,
    sent_at: new Date().toISOString(),
  });
  const payload = JSON.stringify(event);
  const itemHeader = JSON.stringify({
    type: "event",
    length: new TextEncoder().encode(payload).length,
  });
  return `${header}\n${itemHeader}\n${payload}\n`;
}

/** Never throws. This is the thing that reports failures; it may not become one. */
export async function sendToSentry(
  config: SentryConfig,
  report: SentryReport,
): Promise<SendResult> {
  const target = parseSentryDsn(config.dsn);
  if (!target) return { ok: false, skipped: true };

  try {
    const response = await fetch(target.envelopeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": [
          "Sentry sentry_version=7",
          "sentry_client=lite-telemetry/1.0",
          `sentry_key=${target.publicKey}`,
        ].join(", "),
      },
      body: encodeEnvelope(buildSentryEvent(config, report)),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, status: response.status, error: body.slice(0, 200) };
    }
    return { ok: true, status: response.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// PostHog
// ---------------------------------------------------------------------------

export type PostHogEvent = {
  event: string;
  distinctId: string;
  orgId?: string;
  properties?: Record<string, unknown>;
  timestamp?: number;
};

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/**
 * Send a batch of server-side events.
 *
 * Batched because most callers produce several at once — a sweep touching N
 * orgs — and because PostHog rate-limits per request rather than per event.
 */
export async function sendToPostHog(
  config: PostHogConfig,
  events: PostHogEvent[],
): Promise<SendResult> {
  const apiKey = config.apiKey?.trim();
  if (!apiKey) return { ok: false, skipped: true };
  if (events.length === 0) return { ok: true };

  const host = (config.host?.trim() || DEFAULT_POSTHOG_HOST).replace(/\/+$/, "");

  const batch = events.map((event) => ({
    event: event.event,
    distinct_id: event.distinctId,
    timestamp: new Date(event.timestamp ?? Date.now()).toISOString(),
    properties: {
      ...(redactRecord(event.properties) ?? {}),
      $lib: "lite-telemetry",
      platform: "server",
      service: config.service,
      environment: config.environment,
      // Grouped on the org so cohort and funnel analysis works per tenant
      // rather than smearing every server-side event across one identity.
      ...(event.orgId ? { $groups: { organization: event.orgId } } : {}),
    },
  }));

  try {
    const response = await fetch(`${host}/batch/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, batch }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, status: response.status, error: body.slice(0, 200) };
    }
    return { ok: true, status: response.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
