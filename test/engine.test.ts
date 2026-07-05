import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import { DdbApiError, DdbParseError } from "../src/client/errors.js";
import type { HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("search/"), "https://example.test/search/");
  assert.equal(
    e.buildUrl("/search", { query: "x", facet: ["a", "b"] }),
    "https://example.test/search?query=x&facet=a&facet=b",
  );
});

test("getJson parses a JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: true });
});

test("getJson throws DdbParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), DdbParseError);
});

test("getText returns the decoded body (e.g. /version)", async () => {
  const mt = makeMockTransport(() => rawResponse("5.6.7", "text/plain"));
  const e = new RequestEngine({ transport: mt.transport });
  assert.equal(await e.getText("/version"), "5.6.7");
  assert.equal(mt.last().headers?.["Accept"], "*/*");
});

test("a DDB error envelope maps to DdbApiError with name + message", async () => {
  const mt = makeMockTransport(() =>
    jsonResponse({ name: "NotAuthorizedException", message: "no access", stacktrace: "" }, 403),
  );
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/search"),
    (err) =>
      err instanceof DdbApiError &&
      err.status === 403 &&
      err.detail === "no access" &&
      err.apiName === "NotAuthorizedException",
  );
});

test("a 503 is retried up to maxRetries then surfaces as DdbApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ message: "busy" }, 503);
  });
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 2, sleep: async () => {} });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof DdbApiError && err.status === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("a retried request that then succeeds resolves", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/x");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});

function redirectResponse(location: string, status = 302): HttpResponse {
  return { status, headers: { location }, body: Buffer.alloc(0) };
}

test("a same-origin redirect is followed and keeps the Authorization header", async () => {
  let calls = 0;
  const mt = makeMockTransport((req) => {
    calls += 1;
    if (calls === 1) return redirectResponse(new URL(req.url).origin + "/moved");
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({
    baseUrl: "https://api.test",
    transport: mt.transport,
    defaultHeaders: { Authorization: 'OAuth oauth_consumer_key="SECRET"' },
  });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(mt.calls[1]?.headers?.["Authorization"], 'OAuth oauth_consumer_key="SECRET"');
});

test("a cross-origin redirect drops credential headers", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? redirectResponse("https://evil.example/collect") : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({
    baseUrl: "https://api.test",
    transport: mt.transport,
    defaultHeaders: {
      Authorization: 'OAuth oauth_consumer_key="SECRET"',
      "X-API-Key": "SECRET",
      Cookie: "session=abc",
    },
  });
  await e.getJson("/x");
  const followUp = mt.calls[1]!;
  assert.equal(new URL(followUp.url).origin, "https://evil.example");
  assert.equal(followUp.headers?.["Authorization"], undefined);
  assert.equal(followUp.headers?.["X-API-Key"], undefined);
  assert.equal(followUp.headers?.["Cookie"], undefined);
  assert.equal(followUp.headers?.["Accept"], "application/json");
});

test("a 3xx without a Location surfaces as a DdbApiError", async () => {
  const mt = makeMockTransport(() => ({ status: 302, headers: {}, body: Buffer.alloc(0) }));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof DdbApiError && err.status === 302,
  );
});
