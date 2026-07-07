import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, sanitizeServerText } from "../src/client/engine.js";
import { DdbApiError, DdbParseError } from "../src/client/errors.js";
import type { HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

// Control characters are built via char codes so no raw control byte ever appears
// in this source file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const NUL = String.fromCharCode(0x00);

test("sanitizeServerText strips C0/C1 control bytes but keeps tab and newline", () => {
  const tab = String.fromCharCode(0x09);
  const nl = String.fromCharCode(0x0a);
  const c1 = String.fromCharCode(0x9b); // a C1 control (CSI)
  const del = String.fromCharCode(0x7f);
  assert.equal(sanitizeServerText(`a${ESC}[31mb${BEL}${NUL}c`), "a[31mbc");
  assert.equal(sanitizeServerText(`x${tab}y${nl}z`), `x${tab}y${nl}z`);
  assert.equal(sanitizeServerText(`p${c1}${del}q`), "pq");
  assert.equal(sanitizeServerText("plain <edm>OK</edm>"), "plain <edm>OK</edm>");
});

test("error detail is stripped of terminal control characters (DDB-01)", async () => {
  // JSON.parse turns the six-char backslash-u-001b escape below into a real ESC.
  const evil = JSON.stringify({ message: `pwn${ESC}]0;title${BEL}ed` });
  const mt = makeMockTransport(() => rawResponse(evil, "application/json", 400));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => {
      assert.ok(err instanceof DdbApiError);
      // detail is sanitized: the ESC and BEL bytes are gone, text otherwise intact.
      assert.equal(err.detail, "pwn]0;titleed");
      assert.ok(!err.detail!.includes(ESC));
      // The full raw body (the JSON envelope) is preserved untouched.
      assert.equal(err.body, evil);
      return true;
    },
  );
});

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
    defaultHeaders: { Authorization: "Bearer SECRET" },
  });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(mt.calls[1]?.headers?.["Authorization"], "Bearer SECRET");
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
      Authorization: "Bearer SECRET",
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
