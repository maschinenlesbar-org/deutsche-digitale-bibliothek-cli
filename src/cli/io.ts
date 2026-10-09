// I/O seam for the CLI. Everything the CLI writes goes through a CliIO object so
// tests can capture output instead of hitting the real stdout/stderr/filesystem.

import { lstatSync, statSync, writeFileSync } from "node:fs";
import type { DdbClient, DdbClientOptions } from "../client/client.js";
import { DdbError } from "../client/errors.js";
import { createLogger, type Logger } from "./log.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /**
   * Persist raw bytes to a file. Refuses to clobber an existing file unless
   * `force` is set, and surfaces any filesystem failure as a typed `DdbError`
   * with a clean message rather than a bare Node fs error.
   */
  writeFile(path: string, data: Buffer, force?: boolean): void;
  /**
   * Check an `-o` path before any request, with the same errors `writeFile` raises:
   * a directory, or an existing file without `force`. Throws a `DdbError`; returns
   * when the write may go ahead. `writeFile` still refuses to clobber (the file may
   * appear meanwhile). Optional: an I/O object without it skips the early check.
   */
  checkOutput?(path: string, force?: boolean): void;
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
  /**
   * Where diagnostics go: one record per line on stderr, in the `--log-format`
   * (`log.ts`). `run()` sets it from argv; deps without it log text through `io.err`.
   */
  log?: Logger;
  /** The clock the log's timestamps come from. Unset, the real one. */
  now?: () => Date;
}

/** The deps' logger, or one that writes text records through `io.err`. */
export function logOf(deps: CliDeps): Logger {
  return deps.log ?? createLogger({ format: "text", write: (line) => deps.io.err(line), ...(deps.now === undefined ? {} : { now: deps.now }) });
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
 * with EPIPE (ENOTCONN when stdout is a socket whose peer has gone, as when a Node
 * parent spawns the CLI with piped stdio on macOS). That is ordinary use, so the
 * process exits 0 at once, quietly. Any
 * other stdout error prints one `Output error: <message>` line to stderr and exits
 * 1. On stderr an EPIPE is ignored, so a failed run keeps its exit code; any other stderr
 * error exits 1 silently (there is nowhere left to report it).
 * The bin shim installs this once, before `run()`.
 */
export function handleOutputErrors(
  streams: OutputStreams = process,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  streams.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (readerGone(err)) return exit(0);
    process.stderr.write(`Output error: ${err.message}\n`);
    exit(1);
  });
  // stderr's reader going away doesn't make a failed run a success: ignore EPIPE there and
  // let the run's own exit code stand (`2>&1 | true` used to turn a usage error into 0).
  streams.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (!readerGone(err)) exit(1);
  });
}

/** True for the write errors that mean the reader has gone: EPIPE, or ENOTCONN on a socket. */
function readerGone(err: NodeJS.ErrnoException): boolean {
  return err.code === "EPIPE" || err.code === "ENOTCONN";
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when something — a file, a directory, a symlink (even a dangling one) — is at `path`. */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function directoryError(path: string, cause?: unknown): DdbError {
  return new DdbError(`"${path}" is a directory; give a file path to --output.`, { cause });
}

function existingFileError(path: string, cause?: unknown): DdbError {
  return new DdbError(`Refusing to overwrite existing file "${path}"; pass --force to overwrite.`, { cause });
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
      if ((code === "EEXIST" || code === "EISDIR") && isDirectory(path)) throw directoryError(path, cause);
      if (code === "EEXIST") throw existingFileError(path, cause);
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new DdbError(`Could not write to "${path}": ${reason}`, { cause });
    }
  },
  checkOutput: (path, force = false) => {
    // The same refusals as writeFile, before the request rather than after it.
    if (isDirectory(path)) throw directoryError(path);
    if (!force && exists(path)) throw existingFileError(path);
  },
  outBinary: (data) => process.stdout.write(data),
  isTerminal: () => process.stdout.isTTY === true,
};
