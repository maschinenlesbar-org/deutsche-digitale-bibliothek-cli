import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { defaultIO, handleOutputErrors } from "../src/cli/io.js";
import { DdbError } from "../src/client/errors.js";

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

function writeError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`write ${code}`);
  err.code = code;
  return err;
}

function setupStreams() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
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
