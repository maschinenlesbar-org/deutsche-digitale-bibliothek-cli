import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RETRY_AFTER_MS, RequestEngine, parseRetryAfter, sanitizeServerText } from "../src/client/engine.js";
import { DdbApiError, DdbError, DdbNetworkError, DdbParseError, redactUrl } from "../src/client/errors.js";
import { DdbClient } from "../src/client/client.js";
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

test("a non-http(s) base URL is rejected by the engine before any request", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org", "not a url"]) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err) => err instanceof DdbNetworkError,
      baseUrl,
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("a base URL with a query or fragment is rejected at construction", () => {
  for (const baseUrl of ["https://example.test/2?x=1", "https://example.test/2#frag", "https://example.test?"]) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ transport: mt.transport, baseUrl }),
      (err: unknown) =>
        err instanceof DdbNetworkError && /Base URL must not contain a query or fragment/.test(err.message),
      baseUrl,
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("search/"), "https://example.test/search/");
  assert.equal(
    e.buildUrl("/search", { query: "x", facet: ["a", "b"] }),
    "https://example.test/search?query=x&facet=a&facet=b",
  );
});

test("a . or .. path segment is rejected without a request (library callers too)", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const client = new DdbClient({ transport: mt.transport });
  // The client's own rules (pathNameProblem, normalizeItemId) reject these first ...
  await assert.rejects(
    () => client.search({ query: "x", collection: "..", requestHandler: ".." }),
    (err) =>
      err instanceof DdbError &&
      err.message === 'Invalid collection: "." and ".." are path navigation, not a name.',
  );
  await assert.rejects(() => client.item("."), DdbError);
  assert.equal(mt.calls.length, 0);
  // ... and the engine's guard stays as the backstop for any other path.
  const engine = new RequestEngine({ transport: mt.transport });
  assert.throws(
    () => engine.buildUrl("/search/index/../.."),
    (err) =>
      err instanceof DdbError &&
      err.message === 'Invalid path segment ".." in /search/index/../..: "." and ".." cannot be used as an id.',
  );
  await assert.rejects(() => engine.getJson("/items/./view"), DdbError);
  assert.equal(mt.calls.length, 0);
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

// ---- Retry-After ----

function retryingEngine(retryAfter: string | undefined, maxRetries = 2) {
  const delays: number[] = [];
  const mt = makeMockTransport(() => ({
    status: 429,
    headers: {
      "content-type": "application/json",
      ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    },
    body: Buffer.from(JSON.stringify({ message: "slow down" })),
  }));
  const engine = new RequestEngine({
    transport: mt.transport,
    maxRetries,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { engine, mt, delays };
}

test("a 429 with Retry-After in seconds waits that long before each retry", async () => {
  const { engine, mt, delays } = retryingEngine("1");
  await assert.rejects(() => engine.getJson("/x"), (e: unknown) => e instanceof DdbApiError && e.status === 429);
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test("without a usable Retry-After the retries back off linearly", async () => {
  for (const header of [undefined, "", "-1", "1.5", "soon", "1e3", "2026-09-26T10:00:00Z"]) {
    const { engine, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getJson("/x"));
    assert.deepEqual(delays, [200, 400], String(header));
  }
});

test("a Retry-After above MAX_RETRY_AFTER_MS is not retried: the error surfaces at once", async () => {
  for (const header of ["31", "99999999999999999999", "Fri, 31 Dec 9999 23:59:59 GMT"]) {
    const { engine, mt, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getJson("/x"), (e: unknown) => e instanceof DdbApiError && e.status === 429);
    assert.equal(mt.calls.length, 1, header);
    assert.deepEqual(delays, [], header);
  }
});

test("parseRetryAfter reads delay-seconds and IMF-fixdate HTTP-dates", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter(" 30 ", now), 30_000);
  assert.equal(parseRetryAfter(["2", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0); // past date: retry now
  for (const bad of [undefined, "", "-1", "+5", "1.5", "1e3", "0x10", "Saturday, 26-Sep-26 10:00:05 GMT"]) {
    assert.equal(parseRetryAfter(bad, now), undefined, String(bad));
  }
  assert.equal(MAX_RETRY_AFTER_MS, 30_000);
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
      "Proxy-Authorization": "Basic SECRET",
      "X-Auth-Token": "SECRET",
    },
  });
  await e.getJson("/x");
  const followUp = mt.calls[1]!;
  assert.equal(new URL(followUp.url).origin, "https://evil.example");
  // Only the engine's own headers go along; every caller header is dropped.
  assert.deepEqual(Object.keys(followUp.headers ?? {}).sort(), ["Accept", "User-Agent"]);
  assert.equal(followUp.headers?.["Accept"], "application/json");
  // The first request's headers were not mutated.
  assert.equal(mt.calls[0]!.headers?.["Proxy-Authorization"], "Basic SECRET");
});

test("an https->http redirect downgrade warns and strips credentials (DDB-04)", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? redirectResponse("http://api.test/moved") : jsonResponse({ ok: 1 });
  });
  const warnings: string[] = [];
  const e = new RequestEngine({
    baseUrl: "https://api.test",
    transport: mt.transport,
    defaultHeaders: { Authorization: "Bearer SECRET" },
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  // Credentials stripped on the downgrade hop...
  assert.equal(mt.calls[1]?.headers?.["Authorization"], undefined);
  // ...and a single stderr-bound warning was emitted.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /https->http redirect downgrade/);
});

test("a same-scheme https redirect emits no downgrade warning (DDB-04)", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? redirectResponse("https://api.test/moved") : jsonResponse({ ok: 1 });
  });
  const warnings: string[] = [];
  const e = new RequestEngine({
    baseUrl: "https://api.test",
    transport: mt.transport,
    warn: (m) => warnings.push(m),
  });
  await e.getJson("/x");
  assert.equal(warnings.length, 0);
});

test("a 3xx without a Location surfaces as a DdbApiError", async () => {
  const mt = makeMockTransport(() => ({ status: 302, headers: {}, body: Buffer.alloc(0) }));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) =>
      err instanceof DdbApiError &&
      err.status === 302 &&
      err.message === "HTTP 302 for GET https://api.deutsche-digitale-bibliothek.de/2/x: redirect not followed (no Location header)",
  );
});

test("a malformed Location is a DdbApiError naming it, not a raw TypeError", async () => {
  const mt = makeMockTransport(() => redirectResponse("http://[::1"));
  const e = new RequestEngine({ baseUrl: "http://127.0.0.1:18109/2", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) =>
      err instanceof DdbApiError &&
      err.location === "http://[::1" &&
      err.message === "HTTP 302 for GET http://127.0.0.1:18109/2/x: redirect to http://[::1 not followed",
  );
  assert.equal(mt.calls.length, 1);
});

test("a redirect loop stops after maxRedirects and names the target", async () => {
  const mt = makeMockTransport((req) => redirectResponse(req.url));
  const e = new RequestEngine({ baseUrl: "http://u:p@127.0.0.1:18109/2", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) =>
      err instanceof DdbApiError &&
      err.message === "HTTP 302 for GET http://***@127.0.0.1:18109/2/x: redirect to http://***@127.0.0.1:18109/2/x not followed",
  );
  assert.equal(mt.calls.length, 6); // initial + 5 redirects
});

test("only 301/302/303/307/308 are followed; 300/304/305 surface as errors", async () => {
  for (const status of [300, 304, 305]) {
    const mt = makeMockTransport(() => redirectResponse("/elsewhere", status));
    const e = new RequestEngine({ baseUrl: "https://api.test/2", transport: mt.transport });
    await assert.rejects(
      () => e.getJson("/x"),
      (err) =>
        err instanceof DdbApiError &&
        err.status === status &&
        /: redirect to https:\/\/api\.test\/elsewhere not followed$/.test(err.message),
      String(status),
    );
    assert.equal(mt.calls.length, 1);
  }
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    const mt = makeMockTransport(() => (++calls === 1 ? redirectResponse("/moved", status) : jsonResponse({ ok: 1 })));
    const e = new RequestEngine({ baseUrl: "https://api.test/2", transport: mt.transport });
    assert.deepEqual(await e.getJson("/x"), { ok: 1 }, String(status));
  }
});

test("redactUrl hides userinfo and leaves other URLs alone", () => {
  assert.equal(redactUrl("https://u:p@example.test/a?b=1"), "https://***@example.test/a?b=1");
  assert.equal(redactUrl("https://token@example.test/"), "https://***@example.test/");
  assert.equal(redactUrl("https://example.test/a b"), "https://example.test/a b");
  assert.equal(redactUrl("not a url"), "not a url");
  const err = new DdbApiError({ status: 500, url: "https://u:p@example.test/x", method: "GET", body: "" });
  assert.equal(err.url, "https://***@example.test/x");
  assert.ok(!err.message.includes("u:p"));
});
