// Compile-time checks of the exported library types, and the runtime behaviour they promise.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DdbClient } from "../src/index.js";
import { RequestEngine } from "../src/engine.js";
import { makeMockTransport, jsonResponse, queryOf } from "./helpers.js";
import * as fx from "./fixtures.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "ddb-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { DdbClient, type DdbClientOptions, type EngineOptions, type ItemOptions, type RequestOptions, type SearchParams } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const a: DdbClientOptions = allUndefined<DdbClientOptions>();",
        "export const b: EngineOptions = allUndefined<EngineOptions>();",
        "export const c: ItemOptions = allUndefined<ItemOptions>();",
        "export const d: Omit<SearchParams, 'query'> = allUndefined<Omit<SearchParams, 'query'>>();",
        "export const e: Omit<RequestOptions, 'accept'> = allUndefined<Omit<RequestOptions, 'accept'>>();",
        "export const client = new DdbClient({ baseUrl: process.env.DDB_BASE_URL, timeoutMs: 15_000 });",
        "export const ids = async (): Promise<string[]> => (await client.search({ query: '*:*', sort: process.env.SORT })).response.docs.map((doc) => doc.id);",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const mt = makeMockTransport(() => jsonResponse(fx.solr));
  const client = new DdbClient({
    baseUrl: undefined,
    userAgent: undefined,
    defaultHeaders: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxRedirects: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    warn: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  await client.search({
    query: "Goethe",
    rows: undefined,
    start: undefined,
    sort: undefined,
    fields: undefined,
    filters: undefined,
    facetFields: undefined,
    facetLimit: undefined,
    collection: undefined,
    requestHandler: undefined,
  });
  const req = mt.last();
  assert.match(req.url, /^https:\/\/api\.deutsche-digitale-bibliothek\.de\/2\/search\/index\/search\/select\?/);
  assert.deepEqual([...queryOf(req).keys()].sort(), ["q", "rows", "wt"]);
  assert.equal(queryOf(req).get("rows"), "10");

  const item = makeMockTransport(() => jsonResponse({ item: {} }));
  await new DdbClient({ transport: item.transport }).item("A".repeat(32), undefined, { lang: undefined, rows: undefined, offset: undefined });
  assert.equal(new URL(item.last().url).pathname, `/2/items/${"A".repeat(32)}/view`);
  assert.equal(new URL(item.last().url).search, "");

  const raw = makeMockTransport(() => jsonResponse({ ok: true }));
  const engine = new RequestEngine({ transport: raw.transport });
  await engine.request("GET", "/version", { accept: "application/json", query: undefined, followRedirect: undefined });
  assert.equal(raw.last().url, "https://api.deutsche-digitale-bibliothek.de/2/version");
});
