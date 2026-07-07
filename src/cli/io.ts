// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { writeFileSync } from "node:fs";
import type { DdbClient, DdbClientOptions } from "../client/client.js";
import { DdbError } from "../client/errors.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /**
   * Persist raw bytes to a file. Refuses to clobber an existing file unless
   * `force` is set, and surfaces any filesystem failure as a typed `DdbError`
   * with a clean message rather than a bare Node fs error.
   */
  writeFile(path: string, data: Buffer, force?: boolean): void;
  /** Write raw bytes to stdout (binary-safe). */
  outBinary(data: Buffer): void;
}

export interface CliDeps {
  io: CliIO;
  /** Build a client from the resolved global options (injectable for tests). */
  createClient(options: DdbClientOptions): DdbClient;
  /**
   * Environment lookup, injected so any env-driven config stays testable without
   * mutating process.env. The v2 read routes need no credentials, so nothing is
   * read from it today; kept as the standard seam. Defaults to process.env.
   */
  env?: Record<string, string | undefined>;
}

export const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  writeFile: (path, data, force = false) => {
    try {
      // `wx` fails if the path already exists, so `-o` never silently clobbers a
      // file. `--force` opts back into overwriting (plain `w`).
      writeFileSync(path, data, { flag: force ? "w" : "wx" });
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EEXIST") {
        throw new DdbError(
          `Refusing to overwrite existing file "${path}"; pass --force to overwrite.`,
          { cause },
        );
      }
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new DdbError(`Could not write to "${path}": ${reason}`, { cause });
    }
  },
  outBinary: (data) => process.stdout.write(data),
};
