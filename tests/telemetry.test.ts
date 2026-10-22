/**
 * Telemetry is the one subsystem whose bugs are invisible in production: a
 * redactor that misses a key leaks quietly, and a stack parser that returns
 * nothing just makes Sentry less useful without ever erroring. Both are pure,
 * so both get tested.
 */

import { describe, expect, it } from "vitest";
import {
  fingerprintFor,
  isSensitiveKey,
  normalizeError,
  parseStack,
  redact,
  redactRecord,
  toLogSeverity,
} from "../src/core";
import { parseSentryDsn } from "../src/transport";

describe("redaction", () => {
  it("removes the values that would make a report a privacy incident", () => {
    const out = redact({
      driverEmail: "someone@example.com",
      phoneNumber: "+15555550123",
      accessToken: "sk_live_FAKEFAKEFAKEFAKE",
      homeAddress: "1 Main St",
      ssn: "000-00-0000",
      latitude: 41.8,
      longitude: -87.6,
    }) as Record<string, unknown>;

    for (const value of Object.values(out)) {
      expect(value).toBe("[redacted]");
    }
  });

  it("keeps the identifiers a report is useless without", () => {
    const out = redact({
      orgId: "org_123",
      loadId: "ld_456",
      status: "delivered",
      attemptCount: 3,
      filename: "rate-con.pdf",
    }) as Record<string, unknown>;

    expect(out).toEqual({
      orgId: "org_123",
      loadId: "ld_456",
      status: "delivered",
      attemptCount: 3,
      filename: "rate-con.pdf",
    });
  });

  it("matches sensitive keys as substrings, whatever the casing", () => {
    expect(isSensitiveKey("email")).toBe(true);
    expect(isSensitiveKey("driverEmailAddress")).toBe(true);
    expect(isSensitiveKey("CONTACT_PHONE")).toBe(true);
    expect(isSensitiveKey("refreshToken")).toBe(true);
    // `name` is sensitive, but these compounds are not people.
    expect(isSensitiveKey("filename")).toBe(false);
    expect(isSensitiveKey("tableName")).toBe(false);
  });

  it("redacts inside nested structures, not just at the top level", () => {
    const out = redact({
      request: {
        headers: { authorization: "Bearer x", "content-type": "application/json" },
        path: "/api/loads",
      },
    }) as Record<string, Record<string, Record<string, unknown>>>;

    // The sensitive header goes; its harmless neighbours stay, which is what
    // makes the surviving context worth reading.
    expect(out.request.headers.authorization).toBe("[redacted]");
    expect(out.request.headers["content-type"]).toBe("application/json");
    expect(out.request.path).toBe("/api/loads");
  });

  it("matches hyphenated and snake_case keys, not just camelCase", () => {
    const out = redact({
      "x-api-key": "k",
      api_key: "k",
      routing_number: "1",
      "user-email": "a@b.c",
    }) as Record<string, unknown>;

    for (const value of Object.values(out)) {
      expect(value).toBe("[redacted]");
    }
  });

  it("survives a cycle rather than throwing inside a catch block", () => {
    const cyclic: Record<string, unknown> = { id: "a" };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });

  it("bounds depth, arrays and strings so one report cannot be unbounded", () => {
    const deep = { a: { b: { c: { d: { e: "too far" } } } } };
    expect(JSON.stringify(redact(deep))).toContain("[depth limit]");

    const long = redact({ note: "x".repeat(5_000) }) as Record<string, string>;
    expect(long.note.length).toBeLessThan(600);

    const big = redact({ items: Array.from({ length: 100 }, (_, i) => i) }) as {
      items: unknown[];
    };
    expect(big.items.length).toBeLessThanOrEqual(21);
    expect(String(big.items.at(-1))).toContain("more");
  });

  it("passes undefined through so callers need no branch", () => {
    expect(redactRecord(undefined)).toBeUndefined();
  });
});

describe("error normalisation", () => {
  it("handles a real Error", () => {
    const out = normalizeError(new TypeError("bad input"));
    expect(out.type).toBe("TypeError");
    expect(out.message).toBe("bad input");
    expect(out.stack).toBeTruthy();
  });

  it("handles the things that are legal to throw but are not Errors", () => {
    expect(normalizeError("boom").message).toBe("boom");
    expect(normalizeError({ message: "from object" }).message).toBe("from object");
    expect(normalizeError(null).type).toBe("ThrownValue");
    expect(normalizeError(undefined).type).toBe("ThrownValue");
  });

  it("redacts a thrown object rather than stringifying it raw", () => {
    const out = normalizeError({ email: "leak@example.com", code: 500 });
    expect(out.message).not.toContain("leak@example.com");
    expect(out.message).toContain("500");
  });
});

describe("stack parsing", () => {
  it("produces frames innermost-last, as Sentry expects", () => {
    const frames = parseStack(
      [
        "Error: nope",
        "    at inner (/app/handlers/inbox.ts:12:5)",
        "    at outer (/app/handlers/inbox.ts:40:9)",
      ].join("\n"),
    );

    expect(frames).toHaveLength(2);
    expect(frames.at(-1)?.function).toBe("inner");
    expect(frames.at(-1)?.lineno).toBe(12);
  });

  it("marks dependency frames as out-of-app so grouping ignores them", () => {
    const frames = parseStack("    at x (/node_modules/foo/index.js:1:1)");
    expect(frames[0].in_app).toBe(false);
  });

  it("parses frames with no function name", () => {
    const frames = parseStack("    at /app/http.ts:7:3");
    expect(frames[0].filename).toBe("/app/http.ts");
    expect(frames[0].lineno).toBe(7);
  });

  it("returns nothing for an absent stack instead of throwing", () => {
    expect(parseStack(undefined)).toEqual([]);
  });
});

describe("grouping", () => {
  it("fingerprints on the code, never the message", () => {
    const a = fingerprintFor({ code: "load.missing_stops", fn: "f", errorType: "Error" });
    const b = fingerprintFor({ code: "load.missing_stops", fn: "f", errorType: "Error" });
    expect(a).toEqual(b);
    expect(a).not.toContain("load abc123 has no stops");
  });

  it("collapses fatal into error for the errorLogs table", () => {
    expect(toLogSeverity("fatal")).toBe("error");
    expect(toLogSeverity("warn")).toBe("warn");
  });
});

describe("DSN parsing", () => {
  it("derives the envelope endpoint", () => {
    const target = parseSentryDsn("https://abc123@o1.ingest.sentry.io/456");
    expect(target).toEqual({
      envelopeUrl: "https://o1.ingest.sentry.io/api/456/envelope/",
      publicKey: "abc123",
    });
  });

  it("returns null rather than throwing on anything unusable", () => {
    expect(parseSentryDsn(undefined)).toBeNull();
    expect(parseSentryDsn("")).toBeNull();
    expect(parseSentryDsn("not-a-url")).toBeNull();
    // No project id — sending here would 404 on every event.
    expect(parseSentryDsn("https://key@host")).toBeNull();
    // No public key — the auth header would be malformed.
    expect(parseSentryDsn("https://host/1")).toBeNull();
  });
});
