// Conformance test P12 (fix plan 2026-10-06): `-o -` means stdout, as in other Unix tools. It
// prints what no `-o` would print and creates no file named `-`. Two checks: in-process
// through run() with captured I/O, and the built bin in a scratch directory against a local
// server, so a repo whose file writing bypasses the I/O seam is caught too. Shared across the
// *-cli repos with `-o`; only the adapter block differs. Pilot: fim-portal-cli.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { DdbClient as Client } from "../src/client/client.js";
/** The built bin, relative to this compiled test file (dist/test/…). */
const BIN = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));
/** The output flag's short and long forms. */
const OUTPUT_FLAGS = ["-o", "--output"];
/** Commands to try, each with the answer the server gives and a marker the output contains. */
const COMMANDS: Array<{ label: string; argv: string[]; response: () => HttpResponse; marker: string }> = [
  {
    label: "a raw XML item part",
    argv: ["item", "JG3YAM7VLFJPVGMAWK4IBCJVFHNFZ5NP", "--part", "source-record"],
    response: () => ({ status: 200, headers: { "content-type": "application/xml" }, body: Buffer.from("<mets>dash-marker</mets>\n") }),
    marker: "dash-marker",
  },
  {
    label: "a JSON command",
    argv: ["search", "Goethe"],
    response: () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ response: { numFound: 1, start: 0, docs: [{ id: "A", label: "dash-marker" }] } })),
    }),
    marker: "dash-marker",
  },
];
/** Global options go before the command in this CLI (they work after it too). */
const withOutput = (flag: string, value: string, argv: string[]): string[] => [flag, value, ...argv];
/**
 * This repo's CliDeps from captured stdout text, binary stdout, stderr and file writes.
 * A repo whose I/O seam has no file or binary hook can map them to its own.
 */
function makeDeps(
  io: { out: (s: string) => void; outBinary: (b: Buffer) => void; err: (s: string) => void; writeFile: (path: string, data: Buffer) => void },
  transport: () => Promise<HttpResponse>,
): CliDeps {
  return {
    io: { out: io.out, err: io.err, outBinary: io.outBinary, writeFile: io.writeFile },
    createClient: (opts) => new Client({ ...opts, transport }),
  };
}
// --------------------------------------------------------------------------------------

function captured(response: () => HttpResponse) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const files: string[] = [];
  const deps = makeDeps(
    {
      out: (s) => stdout.push(s),
      outBinary: (b) => stdout.push(b.toString("utf8")),
      err: (s) => stderr.push(s),
      writeFile: (path) => files.push(path),
    },
    async () => response(),
  );
  return { deps, stdout, stderr, files };
}

/** Every way to say `-o -`: each flag as a separate value, and the long one as `--output=-`. */
function dashForms(argv: string[]): string[][] {
  const forms = OUTPUT_FLAGS.map((flag) => withOutput(flag, "-", argv));
  const long = OUTPUT_FLAGS.find((flag) => flag.startsWith("--"));
  if (long !== undefined) forms.push([`${long}=-`, ...argv]);
  return forms;
}

for (const { label, argv, response, marker } of COMMANDS) {
  test(`P12: -o - prints ${label} to stdout like no -o, and writes no file`, async () => {
    const plain = captured(response);
    assert.equal(await run(argv, plain.deps), 0, plain.stderr.join("\n"));
    assert.ok(plain.stdout.join("").includes(marker));
    for (const args of dashForms(argv)) {
      const dash = captured(response);
      const code = await run(args, dash.deps);
      assert.equal(code, 0, `${args.join(" ")}: ${dash.stderr.join("\n")}`);
      assert.deepEqual(dash.files, [], `${args.join(" ")} wrote a file`);
      assert.equal(dash.stdout.join(""), plain.stdout.join(""), args.join(" "));
    }
  });
}

/** Run the built bin in `cwd` and collect its output. */
function runBin(cwd: string, argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...argv], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("P12: the built bin creates no file named '-' in its working directory", async () => {
  for (const { argv, response, marker } of COMMANDS) {
    const server = http.createServer((_req, res) => {
      const r = response();
      res.writeHead(r.status, r.headers as http.OutgoingHttpHeaders);
      res.end(r.body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const cwd = mkdtempSync(join(tmpdir(), "p12-"));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const out = await runBin(cwd, ["--base-url", base, ...withOutput(OUTPUT_FLAGS[0]!, "-", argv)]);
      assert.equal(out.code, 0, out.stderr);
      assert.ok(out.stdout.includes(marker), `${argv.join(" ")}: stdout ${JSON.stringify(out.stdout)}`);
      assert.equal(existsSync(join(cwd, "-")), false, `${argv.join(" ")} created a file named '-'`);
      assert.deepEqual(readdirSync(cwd), []);
    } finally {
      server.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});
