import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { nodeHttpTransport } from "../src/client/http.js";
import { DdbNetworkError } from "../src/client/errors.js";

/** Start a throwaway loopback server for one test and return its base URL. */
async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("performs a real GET and returns status, headers and body", async () => {
  await withServer(
    (req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url }));
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({ method: "GET", url: `${baseUrl}/search` });
      assert.equal(resp.status, 200);
      assert.equal(resp.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(resp.body.toString("utf8")), { path: "/search" });
    },
  );
});

test("rejects an unsupported protocol with DdbNetworkError", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "ftp://example.test/x" }),
    DdbNetworkError,
  );
});

test("enforces maxResponseBytes", async () => {
  await withServer(
    (_req, res) => res.end("x".repeat(1000)),
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: 10 }),
        DdbNetworkError,
      );
    },
  );
});

test("a slow drip that never idles still hits the wall-clock deadline (DDB-03)", async () => {
  // The server writes one byte every 15ms and never ends. Each write resets the
  // idle-socket timeout, so only the total deadline can stop this — proving the
  // deadline is a wall-clock limit, not just an idle-socket timeout.
  const timers: NodeJS.Timeout[] = [];
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      const drip = (): void => {
        res.write("x");
        timers.push(setTimeout(drip, 15));
      };
      drip();
    },
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 60 }),
        (err) => err instanceof DdbNetworkError && /deadline/.test(err.message),
      );
    },
  );
  for (const t of timers) clearTimeout(t);
});
