// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { statSync, writeFileSync } from "node:fs";
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
  /**
   * Whether stdout is a terminal. Raw server bodies are cleaned of control bytes
   * only for a terminal; a pipe or redirect gets the exact bytes. Absent means
   * "treat as a terminal" (the safe default).
   */
  isTerminal?(): boolean;
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

/** The two process streams, as far as `handleOutputErrors` needs them. */
export interface OutputStreams {
  stdout: Pick<NodeJS.WriteStream, "on">;
  stderr: Pick<NodeJS.WriteStream, "on">;
}

/**
 * Handle write errors on stdout/stderr, which Node otherwise reports as an
 * unhandled 'error' event: a raw stack trace and exit 1.
 *
 * A reader that stops early — `| head`, `| jq` exiting on the first match, a closed
 * pager — closes the pipe while the CLI is still writing, and the next write fails
 * with EPIPE. That is ordinary use, so the process exits 0 at once, quietly. Any
 * other stdout error prints one `Output error: <message>` line to stderr and exits
 * 1; any other stderr error exits 1 silently (there is nowhere left to report it).
 * The bin shim installs this once, before `run()`.
 */
export function handleOutputErrors(
  streams: OutputStreams = process,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") return exit(0);
    process.stderr.write(`Output error: ${err.message}\n`);
    exit(1);
  });
  streams.stderr.on("error", (err: NodeJS.ErrnoException) => {
    exit(err.code === "EPIPE" ? 0 : 1);
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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
      // `wx` answers EEXIST and `w` EISDIR for a directory; --force cannot help there.
      if ((code === "EEXIST" || code === "EISDIR") && isDirectory(path)) {
        throw new DdbError(`"${path}" is a directory; give a file path to --output.`, { cause });
      }
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
  isTerminal: () => process.stdout.isTTY === true,
};
