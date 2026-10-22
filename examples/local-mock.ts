/**
 * End-to-end demo with no Sentry or PostHog account.
 *
 * Starts a local HTTP server, points both senders at it, reports one error and
 * one batch of product events, then prints exactly what went over the wire.
 * Also shows the three outcomes a caller has to tell apart: delivered, skipped
 * (not configured) and failed (configured but the upstream said no).
 *
 *   pnpm example
 */

import {
  normalizeError,
  sendToPostHog,
  sendToSentry,
  traceId,
} from "../src/index";
import { decodeEnvelope, startMockServer } from "./mock-server";

function section(title: string) {
  console.log(`\n=== ${title} ${"=".repeat(Math.max(0, 66 - title.length))}`);
}

async function main() {
  const mock = await startMockServer();

  // A DSN is `https://<publicKey>@<host>/<projectId>`; plain http is fine
  // locally. The public key below is a placeholder, not a credential.
  const sentryConfig = {
    dsn: `http://examplepublickey@${mock.host}/42`,
    environment: "demo",
    release: "1.0.0",
    service: "dispatch-api",
  };
  const postHogConfig = {
    apiKey: "phc_example_not_a_real_key",
    host: mock.baseUrl,
    environment: "demo",
    service: "dispatch-api",
  };

  // Something a real handler might catch: the error itself is fine to report,
  // the context around it is full of personal data.
  let caught: unknown;
  try {
    throw new Error("load ld_456 has no stops");
  } catch (err) {
    caught = err;
  }

  const sharedTrace = traceId();

  const sentryResult = await sendToSentry(sentryConfig, {
    level: "error",
    code: "load.missing_stops",
    fn: "loads.assignDriver",
    error: normalizeError(caught),
    orgId: "org_123",
    userId: "user_789",
    traceId: sharedTrace,
    durationMs: 41,
    extra: {
      loadId: "ld_456",
      attempt: 2,
      driverEmail: "driver@example.com",
      driverPhone: "+15555550123",
      pickup: { latitude: 33.75, longitude: -84.39, city: "Atlanta" },
      request: { headers: { authorization: "Bearer FAKEFAKEFAKE", "content-type": "application/json" } },
    },
  });

  const postHogResult = await sendToPostHog(postHogConfig, [
    {
      event: "load_assigned",
      distinctId: "user_789",
      orgId: "org_123",
      properties: { loadId: "ld_456", driverName: "Example Driver", trace_id: sharedTrace },
    },
    {
      event: "load_delivered",
      distinctId: "user_789",
      orgId: "org_123",
      properties: { loadId: "ld_457", miles: 412 },
    },
  ]);

  section("Sentry envelope (as received by the mock)");
  const sentryRequest = mock.requests.find((r) => r.path.includes("/envelope/"));
  if (sentryRequest) {
    console.log(`POST ${sentryRequest.path}`);
    console.log(`X-Sentry-Auth: ${sentryRequest.headers["x-sentry-auth"]}`);
    const { header, itemHeader, event } = decodeEnvelope(sentryRequest.body);
    console.log("envelope header:", JSON.stringify(header));
    console.log("item header:    ", JSON.stringify(itemHeader));
    console.log("event:");
    console.log(JSON.stringify(event, null, 2));
  }

  section("PostHog batch (as received by the mock)");
  const postHogRequest = mock.requests.find((r) => r.path === "/batch/");
  if (postHogRequest) {
    console.log(`POST ${postHogRequest.path}`);
    const parsed = JSON.parse(postHogRequest.body) as { api_key: string; batch: unknown[] };
    console.log(JSON.stringify({ ...parsed, api_key: "[omitted from demo output]" }, null, 2));
  }

  section("Delivered vs skipped vs failed");
  const skipped = await sendToSentry({ ...sentryConfig, dsn: undefined }, {
    level: "warn",
    code: "demo.unconfigured",
    error: normalizeError("not sent"),
  });
  const failed = await sendToPostHog({ ...postHogConfig, host: `${mock.baseUrl}/fail` }, [
    { event: "demo_failure", distinctId: "user_789" },
  ]);
  console.log("sentry   (configured):     ", JSON.stringify(sentryResult));
  console.log("posthog  (configured):     ", JSON.stringify(postHogResult));
  console.log("sentry   (no DSN):         ", JSON.stringify(skipped));
  console.log("posthog  (upstream 500):   ", JSON.stringify(failed));

  await mock.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
