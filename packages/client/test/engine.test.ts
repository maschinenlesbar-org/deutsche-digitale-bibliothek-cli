import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RETRY_AFTER_MS, RequestEngine, parseRetryAfter, sanitizeServerText, validateBaseUrl } from "../src/engine.js";
import { DdbApiError, DdbError, DdbNetworkError, DdbParseError, DdbValidationError, cutText, redactUrl, toWellFormed } from "../src/errors.js";
import { DdbClient } from "../src/client.js";
import type { HttpResponse } from "../src/http.js";
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

test("a non-http(s) or unparseable base URL is a DdbValidationError before any request", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org", "not a url", ""]) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err) => err instanceof DdbValidationError && !(err instanceof DdbNetworkError),
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
        err instanceof DdbValidationError &&
        err.message === "Invalid baseUrl: A base URL cannot have a query (?) or fragment (#).",
      baseUrl,
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("a base URL with surrounding whitespace is rejected at construction, before the slash strip", () => {
  for (const baseUrl of ["https://example.test/2 ", " https://example.test/2", "https://example.test/2/ ", "\thttps://example.test"]) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ transport: mt.transport, baseUrl }),
      (err: unknown) => err instanceof DdbError && /surrounding whitespace/.test(err.message),
      JSON.stringify(baseUrl),
    );
    assert.equal(mt.calls.length, 0);
  }
  assert.equal(validateBaseUrl("https://example.test/2//"), "https://example.test/2");
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
      // The base URL's userinfo travels as the Authorization header, never in a URL.
      err.message === "HTTP 302 for GET http://127.0.0.1:18109/2/x: redirect to http://127.0.0.1:18109/2/x not followed",
  );
  assert.equal(mt.calls.length, 6); // initial + 5 redirects
  // Same origin on every hop: the credentials go along each time.
  assert.ok(mt.calls.every((c) => c.headers?.["Authorization"] === `Basic ${Buffer.from("u:p").toString("base64")}`));
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

test("defaultHeaders never reach another origin, even through a transport that follows redirects itself (04#10)", async () => {
  // A fetch-style transport that ignores `redirect: "manual"` and reports where it ended up.
  const mt = makeMockTransport(() => ({ ...jsonResponse({ response: {} }), url: "http://localhost:20160/elsewhere" }));
  const e = new RequestEngine({ baseUrl: "http://127.0.0.1:20160/2", transport: mt.transport, defaultHeaders: { "X-Auth-Token": "tok" } });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof DdbNetworkError && /followed a redirect to another origin/.test(err.message),
  );
  assert.equal(mt.last().redirect, "manual", "the transport is told not to follow");
  // The engine's own following drops them on the cross-origin hop and keeps them on the same origin.
  let n = 0;
  const hops = makeMockTransport(() =>
    ++n === 1 ? redirectResponse("http://127.0.0.1:20160/2/same") : n === 2 ? redirectResponse("http://localhost:20160/2/other") : jsonResponse({ ok: 1 }),
  );
  const e2 = new RequestEngine({ baseUrl: "http://127.0.0.1:20160/2", transport: hops.transport, defaultHeaders: { "X-Auth-Token": "tok" } });
  await e2.getJson("/x");
  assert.deepEqual(hops.calls.map((c) => c.headers?.["X-Auth-Token"]), ["tok", "tok", undefined]);
});

test("headers in any case or a Headers object are read (04#7)", async () => {
  for (const headers of [{ "Content-Type": "application/json" }, new Headers({ "content-type": "application/json" })]) {
    const c = new DdbClient({
      transport: async () => ({ status: 200, headers: headers as unknown as HttpResponse["headers"], body: Buffer.from('{"item":{"label":"x"}}') }),
    });
    const r = await c.item("A".repeat(32));
    assert.equal(r.contentType, "application/json");
    assert.deepEqual(r.json, { item: { label: "x" } });
  }
  // A 302 whose Location sits in a Headers object is followed.
  let n = 0;
  const e = new RequestEngine({
    baseUrl: "https://api.test/2",
    transport: async () =>
      ++n === 1
        ? { status: 302, headers: new Headers({ Location: "/2/moved" }) as unknown as HttpResponse["headers"], body: Buffer.alloc(0) }
        : jsonResponse({ ok: 1 }),
  });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
});

test("a Uint8Array or ArrayBuffer body decodes to its text (04#8)", async () => {
  for (const body of [new TextEncoder().encode("7.5"), new TextEncoder().encode("7.5").buffer]) {
    const c = new DdbClient({ transport: async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: body as Buffer }) });
    assert.equal(await c.version(), "7.5");
  }
});

test("a redirect to a non-http(s) scheme is refused before the transport sees it", async () => {
  for (const target of ["file:///etc/passwd", "javascript:alert(1)", "data:text/plain,x"]) {
    const mt = makeMockTransport(() => redirectResponse(target));
    const e = new RequestEngine({ baseUrl: "https://api.test/2", transport: mt.transport });
    await assert.rejects(() => e.getJson("/x"), (err) => err instanceof DdbNetworkError && /unsupported protocol/.test(err.message), target);
    assert.equal(mt.calls.length, 1, target);
  }
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
});

test("a server detail cut at 500 characters keeps the message well-formed", async () => {
  for (const message of ["\u{1f600}".repeat(400), "a" + "\u{1f600}".repeat(400)]) {
    const engine = new RequestEngine({ transport: async () => ({ status: 500, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ message })) }) });
    await assert.rejects(engine.getJson("/search/index/search/select"), (err: Error) => {
      assert.equal(toWellFormed(err.message), err.message);
      assert.match(err.message, /…$/);
      return true;
    });
  }
});

test("a quoted /version body cut at 200 characters keeps the message well-formed", async () => {
  for (const body of ["\u{1f600}".repeat(200), "a" + "\u{1f600}".repeat(200)]) {
    const client = new DdbClient({ transport: async () => rawResponse(body, "text/plain; charset=utf-8") });
    await assert.rejects(client.version(), (err: Error) => {
      assert.equal(toWellFormed(err.message), err.message);
      return true;
    });
  }
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  // The engine sends the pair UTF-8 encoded, so that is the form a server echoes.
  const basic = Buffer.from("alice:pa ss-pw", "utf8").toString("base64");
  const engine = new RequestEngine({
    baseUrl: "https://alice:pa%20ss-pw@mirror.test/2",
    maxRetries: 0,
    transport: makeMockTransport(() => jsonResponse({ message: `no: Basic ${basic} / alice:pa ss-pw / pa ss-pw` }, 401)).transport,
  });
  await assert.rejects(engine.getText("/version"), (err: DdbApiError) => {
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) assert.ok(!err.message.includes(form), err.message);
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    for (const form of [basic, "alice:pa ss-pw", "pa ss-pw"]) assert.ok(!err.body.includes(form), err.body);
    return true;
  });
});

test("onRetry is called once per retry, with the event fields, right before the sleep", async () => {
  const log: string[] = [];
  const events: unknown[] = [];
  let n = 0;
  const mt = makeMockTransport(() =>
    n++ < 2
      ? { status: 503, headers: n === 1 ? { "retry-after": "2" } : {}, body: Buffer.from("{}") }
      : jsonResponse({ ok: 1 }),
  );
  const e = new RequestEngine({
    transport: mt.transport,
    baseUrl: "https://user:pw@example.test",
    maxRetries: 3,
    sleep: async (ms) => void log.push(`sleep ${ms}`),
    onRetry: (ev) => {
      events.push(ev);
      log.push("retry");
    },
  });
  await e.getJson("/x");
  assert.deepEqual(log, ["retry", "sleep 2000", "retry", "sleep 400"]);
  assert.deepEqual(events, [
    { retry: 1, maxRetries: 3, delayMs: 2000, status: 503, url: "https://example.test/x" },
    { retry: 2, maxRetries: 3, delayMs: 400, status: 503, url: "https://example.test/x" },
  ]);
});

test("onRetry reports a reset connection without a status", async () => {
  let n = 0;
  const events: unknown[] = [];
  const mt = makeMockTransport(() => {
    if (n++ === 0) throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {}, onRetry: (ev) => void events.push(ev) });
  await e.getJson("/x");
  assert.equal(events.length, 1);
  assert.equal((events[0] as { status?: number }).status, undefined);
  assert.equal((events[0] as { retry: number }).retry, 1);
});

test("onRetry is never called without a retry, and a throw in it is swallowed", async () => {
  const events: unknown[] = [];
  const onRetry = (ev: unknown) => void events.push(ev);
  const ok = new RequestEngine({ transport: makeMockTransport(() => jsonResponse({ ok: 1 })).transport, sleep: async () => {}, onRetry });
  await ok.getJson("/x");
  const notFound = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 404, headers: { "content-type": "application/json" }, body: Buffer.from('{"detail":"no"}') })).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(notFound.getJson("/x"), DdbApiError);
  // retries exhausted: the last 503 is an error, not a retry
  const down = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: {}, body: Buffer.from("{}") })).transport,
    maxRetries: 1,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(down.getJson("/x"), DdbApiError);
  assert.equal(events.length, 1);
  // a Retry-After over the cap is not retried
  const long = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: { "retry-after": "999999" }, body: Buffer.from("{}") })).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(long.getJson("/x"), DdbApiError);
  assert.equal(events.length, 1);
  let n = 0;
  const throwing = new RequestEngine({
    transport: makeMockTransport(() => (n++ === 0 ? { status: 503, headers: {}, body: Buffer.from("{}") } : jsonResponse({ ok: 1 }))).transport,
    sleep: async () => {},
    onRetry: () => {
      throw new Error("boom");
    },
  });
  await throwing.getJson("/x");
});

test("onRetry must be a function", () => {
  assert.throws(() => new RequestEngine({ onRetry: 5 as never }), DdbValidationError);
});

test("a timeout, the size cap, a refused connection and a DNS failure name the request, the original as the cause (kit rollout K3)", async () => {
  const { createServer } = await import("node:net");
  // A port nobody listens on (loopback only): a refused connection from the default transport.
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const closedPort = (closed.address() as { port: number }).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  // A server that accepts and never answers: the default transport's idle timeout.
  const sockets: Array<import("node:net").Socket> = [];
  const silent = createServer((socket) => void sockets.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const silentPort = (silent.address() as { port: number }).port;
  try {
    const dns = Object.assign(new Error("getaddrinfo ENOTFOUND ddb.invalid"), { code: "ENOTFOUND" });
    const cases: Array<[string, string, ConstructorParameters<typeof RequestEngine>[0], RegExp, unknown?]> = [
      ["engine deadline", "http://127.0.0.1:9/2", { transport: () => new Promise<HttpResponse>(() => {}), timeoutMs: 20 }, /^Request exceeded the 20ms deadline$/],
      ["size cap", "http://127.0.0.1:9/2", { transport: async () => rawResponse("x".repeat(100), "application/json"), maxResponseBytes: 10 }, /maxResponseBytes/],
      ["DNS failure", "https://user:pw@ddb.invalid/2", { transport: async () => { throw dns; } }, /^getaddrinfo ENOTFOUND ddb\.invalid$/, dns],
      ["refused connection", `http://127.0.0.1:${closedPort}/2`, {}, /ECONNREFUSED/],
      ["transport timeout", `http://127.0.0.1:${silentPort}/2`, { timeoutMs: 50 }, /timed out|deadline/],
    ];
    for (const [name, base, options, reason, original] of cases) {
      const e = new RequestEngine({ baseUrl: base, maxRetries: 0, ...options });
      // The request URL never carries the base URL's userinfo (it goes as a header), so the
      // message names the request without it.
      const shown = `${base}/version`.replace("user:pw@", "");
      await assert.rejects(e.getJson("/version"), (err) => {
        assert.ok(err instanceof DdbNetworkError, name);
        assert.ok(err.message.startsWith(`GET ${shown} failed: `), `${name}: ${err.message}`);
        assert.ok(!err.message.includes("pw"), name);
        assert.match(err.message.slice(`GET ${shown} failed: `.length), reason, name);
        // The engine's own size check raises the error itself; everything else wraps an original.
        if (name !== "size cap") assert.ok(err.cause !== undefined, `${name}: the original is the cause`);
        if (original !== undefined) assert.equal(err.cause, original, name);
        return true;
      });
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
});

test("bigIntegerKeys: a declared member's number arrives as its literal, as written, in a string; nothing else changes (Bug 05-1, 2026-10-21)", async () => {
  const answer = (body: string) => makeMockTransport(() => rawResponse(body, "application/json")).transport;
  const keys = new Set(["n"]);
  const e = (body: string) => new RequestEngine({ transport: answer(body), bigIntegerKeys: keys });
  assert.deepEqual(
    await e('{"n":12345678901234567890,"m":[{"n":-0},{"n":1.5e3}],"s":"\\"n\\":1","o":{"n":null},"t":{"n":"9"}}').getJson("/x"),
    { n: "12345678901234567890", m: [{ n: "-0" }, { n: "1.5e3" }], s: '"n":1', o: { n: null }, t: { n: "9" } },
  );
  // Without the option every number keeps the rule: exact or refused.
  await assert.rejects(new RequestEngine({ transport: answer('{"n":12345678901234567890}') }).getJson("/x"), /the number 12345678901234567890 cannot be represented exactly/);
  // An undeclared one is refused, a declared one never.
  await assert.rejects(e('{"n":12345678901234567890,"m":12345678901234567891}').getJson("/x"), /the number 12345678901234567891 cannot/);
  // A literal JSON does not allow stays a parse error: quoting it must not make bad JSON good.
  for (const bad of ['{"n":01}', '{"n":1.}', '{"n":-}', '["n":1]']) {
    await assert.rejects(e(bad).getJson("/x"), (err: unknown) => err instanceof DdbParseError && /not valid JSON/.test(err.message), bad);
  }
  // The set is copied: a later change by the caller has no effect.
  const mutable = new Set(["n"]);
  const engine = new RequestEngine({ transport: answer('{"n":1,"m":2}'), bigIntegerKeys: mutable });
  mutable.add("m");
  assert.deepEqual(await engine.getJson("/x"), { n: "1", m: 2 });
});

test("a subnormal number that does not print as written is refused; one that does passes (Bug 02-2, D4, 2026-10-21)", async () => {
  // Below the smallest normal double a double has fewer significant digits: 3e-324 printed as
  // 5e-324 and 1.2345678901234567e-320 as 1.2347e-320, exit 0.
  const answer = (n: string) => new RequestEngine({ transport: makeMockTransport(() => rawResponse(`{"n":${n}}`, "application/json")).transport });
  for (const n of ["3e-324", "4e-324", "-4.9e-324", "1.2345678901234567e-310", "2.225073858507201e-309", "1.2345678901234567e-320"]) {
    await assert.rejects(answer(n).getJson("/x"), (err: unknown) => {
      assert.ok(err instanceof DdbParseError, n);
      assert.match(err.message, new RegExp(`the number ${n.replace(/[.+]/g, "\\$&")} cannot be represented exactly`), n);
      return true;
    });
  }
  for (const [n, value] of [["5e-324", 5e-324], ["-5e-324", -5e-324], ["1e-310", 1e-310], ["2.2250738585072014e-308", 2.2250738585072014e-308]] as const) {
    assert.equal((await answer(n).getJson<{ n: number }>("/x")).n, value, n);
  }
});

test("bigIntegerKeys must be a set or list of non-empty strings", () => {
  for (const bad of ["n", 5, null, [""], [1], new Set([2])] as unknown[]) {
    assert.throws(
      () => new RequestEngine({ bigIntegerKeys: bad as ReadonlySet<string> }),
      (err: unknown) => err instanceof DdbValidationError && /^Invalid option bigIntegerKeys: /.test(err.message),
      String(bad),
    );
  }
  assert.doesNotThrow(() => new RequestEngine({ bigIntegerKeys: new Set() }));
});

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12, 2026-10-21)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key. Copied
  // with `record[name] = value` it became the record's prototype, and its entries read as headers.
  const headers = JSON.parse('{"__proto__":{"content-type":"application/json; charset=x-bogus"}}') as Record<string, string>;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await e.getJson("/x"), { a: 1 });
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "application/json"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await f.getJson("/x"), { a: 1 });
});

test("an answer error names the request: method and URL, userinfo redacted (T9, D9, 2026-10-21)", async () => {
  const answers: Array<[string, () => HttpResponse]> = [
    ["the answer is not valid JSON (expected JSON, got Content-Type \"text/html\")", () => rawResponse("<html>", "text/html")],
    ["empty response body", () => rawResponse(" ", "application/json")],
    ["cannot be represented exactly", () => rawResponse('{"n":1e400}', "application/json")],
    ["unsupported response charset", () => rawResponse("{}", "application/json; charset=x-bogus")],
  ];
  for (const [what, respond] of answers) {
    const e = new RequestEngine({ baseUrl: "https://alice:s3cret@api.example/2", transport: makeMockTransport(respond).transport });
    await assert.rejects(e.getJson("/search/index/search/select", { q: "x" }), (err: unknown) => {
      assert.ok(err instanceof DdbParseError, what);
      assert.ok(err.message.startsWith("GET https://***@api.example/2/search/index/search/select?q=x: "), err.message);
      assert.ok(err.message.includes(what), err.message);
      assert.ok(!err.message.includes("s3cret"), err.message);
      return true;
    });
  }
  // getText too.
  const text = new RequestEngine({ transport: makeMockTransport(() => rawResponse("7.5", "text/plain; charset=x-bogus")).transport });
  await assert.rejects(text.getText("/version"), /^DdbParseError: GET https:\/\/api\.deutsche-digitale-bibliothek\.de\/2\/version: unsupported response charset "x-bogus"\.$/);
});
