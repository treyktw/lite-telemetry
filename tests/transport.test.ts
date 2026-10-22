/**
 * The senders, end to end against a local HTTP server. These pin the wire
 * format (what Sentry and PostHog actually parse) and the never-throw,
 * skipped-vs-failed contract the callers depend on.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeError } from "../src/core";
import { sendToPostHog, sendToSentry } from "../src/transport";
import {
  decodeEnvelope,
  startMockServer,
  type MockServer,
} from "../examples/mock-server";

let mock: MockServer;

beforeAll(async () => {
  mock = await startMockServer();
});

afterAll(async () => {
  await mock.close();
});

const baseSentry = () => ({
  dsn: `http://pubkey@${mock.host}/7`,
  environment: "test",
  service: "svc",
});

describe("sendToSentry", () => {
  it("posts a three-line envelope whose item length matches the payload bytes", async () => {
    const result = await sendToSentry(baseSentry(), {
      level: "error",
      code: "x.broke",
      fn: "handler",
      error: normalizeError(new Error("naïve message")),
    });
    expect(result).toEqual({ ok: true, status: 200 });

    const request = mock.requests.at(-1)!;
    expect(request.path).toBe("/api/7/envelope/");
    expect(request.headers["content-type"]).toBe("application/x-sentry-envelope");
    expect(String(request.headers["x-sentry-auth"])).toContain("sentry_key=pubkey");

    const lines = request.body.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    const { header, itemHeader, event } = decodeEnvelope(request.body);
    expect(header.event_id).toBe(event.event_id);
    expect(itemHeader.length).toBe(new TextEncoder().encode(lines[2]).length);
    expect(event.fingerprint).toEqual(["x.broke", "handler", "Error"]);
  });

  it("redacts `extra` before it leaves the process", async () => {
    await sendToSentry(baseSentry(), {
      level: "warn",
      code: "x.context",
      error: normalizeError("boom"),
      extra: { loadId: "ld_1", driverEmail: "someone@example.com" },
    });
    const { event } = decodeEnvelope(mock.requests.at(-1)!.body);
    expect(event.extra).toEqual({ loadId: "ld_1", driverEmail: "[redacted]" });
    expect(mock.requests.at(-1)!.body).not.toContain("someone@example.com");
  });

  it("reports a missing DSN as skipped and sends nothing", async () => {
    const before = mock.requests.length;
    const result = await sendToSentry({ ...baseSentry(), dsn: undefined }, {
      level: "error",
      code: "x",
      error: normalizeError("x"),
    });
    expect(result).toEqual({ ok: false, skipped: true });
    expect(mock.requests.length).toBe(before);
  });

  it("returns a failure instead of throwing when the network is unreachable", async () => {
    // Port 9 (discard) on loopback is closed in every sane environment.
    const result = await sendToSentry({ ...baseSentry(), dsn: "http://k@127.0.0.1:9/1" }, {
      level: "error",
      code: "x",
      error: normalizeError("x"),
    });
    expect(result.ok).toBe(false);
    expect(result.skipped).toBeUndefined();
    expect(result.error).toBeTruthy();
  });
});

describe("sendToPostHog", () => {
  const basePostHog = () => ({
    apiKey: "phc_test_FAKEFAKEFAKE",
    host: `${mock.baseUrl}/`,
    environment: "test",
    service: "svc",
  });

  it("batches events, redacts properties and groups by org", async () => {
    const result = await sendToPostHog(basePostHog(), [
      { event: "a", distinctId: "u1", orgId: "org_1", properties: { phone: "+15555550123", n: 1 } },
      { event: "b", distinctId: "u1" },
    ]);
    expect(result).toEqual({ ok: true, status: 200 });

    const request = mock.requests.at(-1)!;
    // Trailing slash on the host must not produce `//batch/`.
    expect(request.path).toBe("/batch/");
    const body = JSON.parse(request.body) as {
      batch: Array<{ event: string; properties: Record<string, unknown> }>;
    };
    expect(body.batch.map((e) => e.event)).toEqual(["a", "b"]);
    expect(body.batch[0].properties.phone).toBe("[redacted]");
    expect(body.batch[0].properties.n).toBe(1);
    expect(body.batch[0].properties.$groups).toEqual({ organization: "org_1" });
    expect(body.batch[1].properties.$groups).toBeUndefined();
  });

  it("distinguishes not-configured, nothing-to-send and upstream failure", async () => {
    expect(await sendToPostHog({ ...basePostHog(), apiKey: "  " }, [
      { event: "a", distinctId: "u" },
    ])).toEqual({ ok: false, skipped: true });

    expect(await sendToPostHog(basePostHog(), [])).toEqual({ ok: true });

    const failed = await sendToPostHog({ ...basePostHog(), host: `${mock.baseUrl}/fail` }, [
      { event: "a", distinctId: "u" },
    ]);
    expect(failed).toEqual({ ok: false, status: 500, error: "mock upstream error" });
  });
});
