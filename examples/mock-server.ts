/**
 * A tiny stand-in for Sentry's envelope endpoint and PostHog's batch endpoint.
 *
 * It records every request and answers 200, except for paths containing
 * `/fail`, which answer 500 so the failed-delivery branch can be exercised
 * without a real vendor misbehaving on cue.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type CapturedRequest = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

export type MockServer = {
  baseUrl: string;
  host: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
};

export async function startMockServer(): Promise<MockServer> {
  const requests: CapturedRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = req.url ?? "/";
      requests.push({
        method: req.method ?? "GET",
        path,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (path.includes("/fail")) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("mock upstream error");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const host = `127.0.0.1:${port}`;

  return {
    baseUrl: `http://${host}`,
    host,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** Split a Sentry envelope back into its three NDJSON parts. */
export function decodeEnvelope(body: string): {
  header: Record<string, unknown>;
  itemHeader: Record<string, unknown>;
  event: Record<string, unknown>;
} {
  const [header, itemHeader, event] = body
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { header, itemHeader, event };
}
