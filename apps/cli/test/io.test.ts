import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { defaultIO, handleOutputErrors, stderrAfterStdout, stdoutWriter } from "../src/cli/io.js";
import { DdbError } from "@maschinenlesbar.org/deutsche-digitale-bibliothek-client/internal/errors";
import { createLogger } from "../src/cli/log.js";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ddb-io-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("writeFile creates a new file (DDB-02)", () => {
  withTempDir((dir) => {
    const path = join(dir, "new.txt");
    defaultIO.writeFile(path, Buffer.from("hello"));
    assert.equal(readFileSync(path, "utf8"), "hello");
  });
});

test("writeFile refuses to overwrite an existing file without force (DDB-02)", () => {
  withTempDir((dir) => {
    const path = join(dir, "exists.txt");
    writeFileSync(path, "original");
    assert.throws(
      () => defaultIO.writeFile(path, Buffer.from("clobber")),
      (err) => err instanceof DdbError && /--force/.test(err.message),
    );
    // The original content is untouched.
    assert.equal(readFileSync(path, "utf8"), "original");
  });
});

test("writeFile overwrites an existing file when force is set (DDB-02)", () => {
  withTempDir((dir) => {
    const path = join(dir, "exists.txt");
    writeFileSync(path, "original");
    defaultIO.writeFile(path, Buffer.from("replaced"), true);
    assert.equal(readFileSync(path, "utf8"), "replaced");
  });
});

test("writeFile wraps a filesystem failure in a DdbError (DDB-02)", () => {
  // Writing into a path whose parent does not exist yields ENOENT, which must be
  // surfaced as a typed DdbError with a clean message, not a raw fs error.
  const path = join(tmpdir(), "ddb-does-not-exist-dir", "child.txt");
  assert.throws(
    () => defaultIO.writeFile(path, Buffer.from("x")),
    (err) => err instanceof DdbError && err.message.startsWith("Could not write to"),
  );
});

// Runs node under a file-size limit.
const STARTS_A_PROCESS = { timeout: 30_000 };
const IO_MODULE = fileURLToPath(new URL("../src/cli/io.js", import.meta.url));

/** `defaultIO.writeFile(path, 100 KB, force)` in a node whose files may grow to 1–2 blocks only. */
function writeUnderSizeLimit(path: string, force: boolean): Promise<string> {
  const script = `import { defaultIO } from ${JSON.stringify(IO_MODULE)};
try { defaultIO.writeFile(${JSON.stringify(path)}, Buffer.alloc(100_000, 120), ${force}); console.log("written"); }
catch (err) { console.log(err.message); }`;
  // SIGXFSZ ignored (inherited through exec), so the write fails with EFBIG instead of killing
  // node; NODE_V8_COVERAGE dropped, so a cut coverage file can't break `npm run coverage`.
  const sh = `trap '' XFSZ; ulimit -f 2; unset NODE_V8_COVERAGE; exec "$0" --input-type=module -e "$1"`;
  return new Promise((resolve) => execFile("/bin/sh", ["-c", sh, process.execPath, script], (_err, stdout, stderr) => resolve(stdout + stderr)));
}

test("an -o write that fails part-way leaves the old file as it was, and no cut or temporary file (kit rollout K7)", STARTS_A_PROCESS, async () => {
  // `-o keep.json --force` under a full disk truncated keep.json and left a cut result; without
  // --force a cut new file stayed and blocked the next run.
  const dir = mkdtempSync(join(tmpdir(), "ddb-io-"));
  try {
    const keep = join(dir, "keep.json");
    writeFileSync(keep, '{"good":"previous result"}\n');
    assert.match(await writeUnderSizeLimit(keep, true), /^Could not write to ".*keep\.json": .*EFBIG/);
    assert.equal(readFileSync(keep, "utf8"), '{"good":"previous result"}\n');
    const fresh = join(dir, "new.json");
    assert.match(await writeUnderSizeLimit(fresh, false), /^Could not write to ".*new\.json": .*EFBIG/);
    assert.deepEqual(readdirSync(dir), ["keep.json"], "no cut file and no temporary file is left");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFile with force keeps the old file's mode and writes through a symlink (kit rollout K7)", () => {
  withTempDir((dir) => {
    const path = join(dir, "out.json");
    writeFileSync(path, "original");
    chmodSync(path, 0o600);
    defaultIO.writeFile(path, Buffer.from("new"), true);
    assert.equal(readFileSync(path, "utf8"), "new");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const link = join(dir, "latest.json");
    symlinkSync(path, link);
    defaultIO.writeFile(link, Buffer.from("newer"), true);
    assert.equal(readFileSync(path, "utf8"), "newer");
    assert.deepEqual(readdirSync(dir).sort(), ["latest.json", "out.json"]);
  });
});

function writeError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`write ${code}`);
  err.code = code;
  return err;
}

function setupStreams() {
  const stdout = new EventEmitter();
  const stderr = Object.assign(new EventEmitter(), { write: () => true });
  const exits: number[] = [];
  handleOutputErrors(
    { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream },
    (code) => exits.push(code),
  );
  return { stdout, stderr, exits };
}

test("EPIPE on stdout (reader closed early, e.g. | head) exits 0 instead of crashing", () => {
  const s = setupStreams();
  // Without a listener, emitting 'error' would throw — the raw stack trace of the bug.
  s.stdout.emit("error", writeError("EPIPE"));
  assert.deepEqual(s.exits, [0]);
});

test("EPIPE on stderr is ignored, so the run keeps its own exit code", () => {
  const s = setupStreams();
  s.stderr.emit("error", writeError("EPIPE"));
  assert.deepEqual(s.exits, []);
});

test("ENOTCONN (stdout is a socket whose reader has gone) is treated like EPIPE", () => {
  const s = setupStreams();
  s.stdout.emit("error", writeError("ENOTCONN"));
  s.stderr.emit("error", writeError("ENOTCONN"));
  assert.deepEqual(s.exits, [0]);
});

test("another stderr write error exits 1", () => {
  const s = setupStreams();
  s.stderr.emit("error", writeError("EIO"));
  assert.deepEqual(s.exits, [1]);
});

test("writeFile to a directory says so, with or without force", () => {
  withTempDir((dir) => {
    for (const force of [false, true]) {
      assert.throws(
        () => defaultIO.writeFile(dir, Buffer.from("x"), force),
        (err) => err instanceof DdbError && err.message === `"${dir}" is a directory; give a file path to --output.`,
        String(force),
      );
    }
  });
});

test("checkOutput passes a new path, and an existing file only with force", () => {
  withTempDir((dir) => {
    defaultIO.checkOutput!(join(dir, "new.txt"));
    const path = join(dir, "exists.txt");
    writeFileSync(path, "original");
    assert.throws(
      () => defaultIO.checkOutput!(path),
      (err) => err instanceof DdbError && err.message === `Refusing to overwrite existing file "${path}"; pass --force to overwrite.`,
    );
    defaultIO.checkOutput!(path, true);
    assert.equal(readFileSync(path, "utf8"), "original");
  });
});

test("checkOutput refuses a directory with or without force, and a dangling symlink without it", () => {
  withTempDir((dir) => {
    for (const force of [false, true]) {
      assert.throws(
        () => defaultIO.checkOutput!(dir, force),
        (err) => err instanceof DdbError && err.message === `"${dir}" is a directory; give a file path to --output.`,
      );
    }
    const link = join(dir, "dangling");
    symlinkSync(join(dir, "missing"), link);
    // writeFile's `wx` would fail on it too (EEXIST).
    assert.throws(() => defaultIO.checkOutput!(link), /Refusing to overwrite existing file/);
  });
});

test("another stdout write error is an ERROR record of ddb.output, in the run's format, and exits 1 (results/04)", () => {
  const stdout = new EventEmitter();
  const written: string[] = [];
  const stderr = Object.assign(new EventEmitter(), { write: (text: string) => written.push(text) > 0 });
  const exits: number[] = [];
  const records: string[] = [];
  const log = createLogger({ format: "jsonl", write: (line) => records.push(line), now: () => new Date("2026-01-02T03:04:05.678Z") });
  handleOutputErrors({ stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream }, (code) => void exits.push(code), log);
  stdout.emit("error", writeError("EBADF"));
  assert.deepEqual(exits, [1]);
  assert.deepEqual(records.map((line) => JSON.parse(line) as unknown), [
    { ts: "2026-01-02T03:04:05.678Z", level: "ERROR", topic: "ddb.output", msg: "Could not write to stdout: write EBADF" },
  ]);
  assert.deepEqual(written, []);
});

test("without a logger, a stdout write error is a text ERROR record on the streams' stderr", () => {
  const stdout = new EventEmitter();
  const written: string[] = [];
  const stderr = Object.assign(new EventEmitter(), { write: (text: string) => written.push(text) > 0 });
  const exits: number[] = [];
  handleOutputErrors({ stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream }, (code) => void exits.push(code));
  stdout.emit("error", writeError("EBADF"));
  assert.deepEqual(exits, [1]);
  assert.equal(written.length, 1);
  assert.match(written[0] ?? "", /^\S+Z ERROR \[ddb\.output\] Could not write to stdout: write EBADF\n$/);
});

/** A stdout as far as the hold needs one: a backlog, and the events that end it. */
class FakeStdout extends EventEmitter {
  writableLength = 0;
}

test("stderr waits for stdout: a record is held while stdout has a backlog, and flushed in order (L11)", () => {
  const stdout = new FakeStdout();
  const written: string[] = [];
  const err = stderrAfterStdout(stdout, (text: string) => written.push(text));
  err("first");
  assert.deepEqual(written, ["first"], "no backlog: written at once");
  stdout.writableLength = 65536;
  err("second");
  err("third");
  assert.deepEqual(written, ["first"], "held while stdout has a backlog");
  stdout.writableLength = 0;
  stdout.emit("drain");
  assert.deepEqual(written, ["first", "second", "third"]);
  // Flushed on close and on error too, never lost.
  stdout.writableLength = 10;
  err("fourth");
  stdout.emit("close");
  stdout.writableLength = 10;
  err("fifth");
  stdout.emit("error", new Error("EPIPE"));
  assert.deepEqual(written, ["first", "second", "third", "fourth", "fifth"]);
});

test("stdout to a regular file gets every byte or an error: a short write is never exit 0 (T6, D6)", () => {
  withTempDir((dir) => {
    const path = join(dir, "stdout.txt");
    const fd = openSync(path, "w");
    try {
      const errors: Error[] = [];
      const streamed: Array<string | Buffer> = [];
      const fake = { fd, write: (data: string | Buffer) => streamed.push(data), emit: (_event: "error", err: Error) => errors.push(err) };
      // The real writer: every byte reaches the file, none goes through the stream; text and bytes.
      stdoutWriter(fake)("x".repeat(100_000));
      stdoutWriter(fake)(Buffer.from([0xfc, 0x0a]));
      const written = readFileSync(path);
      assert.equal(written.length, 100_002);
      assert.deepEqual([...written.subarray(100_000)], [0xfc, 0x0a]);
      assert.deepEqual(streamed, []);
      // A write the file system cuts short: the error reaches stdout's "error" event (exit 1 there).
      const efbig = Object.assign(new Error("EFBIG: file too large, write"), { code: "EFBIG" });
      stdoutWriter(fake, () => { throw efbig; })("more");
      assert.deepEqual(errors, [efbig]);
    } finally {
      closeSync(fd);
    }
  });
  // A pipe or a terminal (not a regular file) goes through the stream as before.
  const streamed: Array<string | Buffer> = [];
  stdoutWriter({ write: (data: string | Buffer) => streamed.push(data), emit: () => true })("y");
  assert.deepEqual(streamed, ["y"]);
});
