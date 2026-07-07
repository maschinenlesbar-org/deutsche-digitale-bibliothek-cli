import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultIO } from "../src/cli/io.js";
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
