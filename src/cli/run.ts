// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import {
  DdbApiError,
  DdbError,
  DdbNetworkError,
  DdbUsageError,
  DdbValidationError,
  credentialsIn,
  redactCredentials,
} from "../client/errors.js";
import { sanitizeServerText } from "../client/engine.js";

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
  });
  rejectRepeatedOptions(command);
  for (const child of command.commands) configureTree(child, deps);
}

/** The options that collect every value they are given (`--filter a --filter b`). */
const REPEATABLE_OPTIONS = new Set(["filter", "facet"]);

/**
 * Make a second occurrence of a single-value option a usage error (exit 2). Commander
 * keeps the last one silently, so `--rows 5 --rows 50` or two `--sort`s ran with only one
 * of them and no sign the other was dropped. Boolean flags and the collecting options
 * (`--filter`, `--facet`) may repeat. The message names the flag, never the values.
 */
function rejectRepeatedOptions(command: Command): void {
  for (const option of command.options) {
    if (!(option.required || option.optional) || option.variadic) continue;
    const name = option.attributeName();
    if (REPEATABLE_OPTIONS.has(name)) continue;
    let seen = 0;
    command.on(`option:${option.name()}`, () => {
      seen += 1;
      if (seen > 1) {
        command.error(`error: option '${option.flags}' was given more than once; it takes one value.`, {
          code: "ddb.repeatedOption",
          exitCode: 2,
        });
      }
    });
  }
}

/**
 * Replace the userinfo of every URL in `text` with `***`, the form `redactUrl` gives
 * (`https://user:secret@host` becomes `https://***@host`). Text-based, so it also covers
 * a URL that does not parse; a backstop behind the exact-string redaction below.
 */
export function redactUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#']*@/gi, "$1***@");
}

/**
 * `deps` with an `io` that redacts the credentials of every argument from everything it
 * prints. Commander echoes rejected values in its errors (`--base-url`, an option given a
 * URL), and the CLI's own messages name unknown commands: whatever path a credential takes
 * to stdout or stderr, the exact userinfo (as `credentialsIn` finds it, plus its
 * control-stripped and JSON-escaped forms) is replaced by `***`. A pattern alone can't
 * delimit a password with spaces, quotes, `#`, `?` or `/`; the exact strings can. Without
 * credentials the output passes through unchanged. The CLI reads no environment variable,
 * so argv is the only source.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const secrets = new Set<string>();
  for (const source of [...argv, ...values]) {
    for (const secret of credentialsIn(source)) {
      secrets.add(secret);
      secrets.add(sanitizeServerText(secret));
      secrets.add(JSON.stringify(secret).slice(1, -1));
    }
  }
  if (secrets.size === 0) return deps;
  const list = [...secrets];
  const redact = (text: string): string => redactUserinfo(redactCredentials(text, list));
  return {
    ...deps,
    io: { ...deps.io, out: (text) => deps.io.out(redact(text)), err: (text) => deps.io.err(redact(text)) },
  };
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  deps = withRedactedOutput(deps, argv);
  const program = buildProgram(deps);
  configureTree(program, deps);

  // A bare invocation (no command) is a help request, not an error: print help
  // to stdout and exit 0, matching `--help`.
  if (argv.length === 0) {
    deps.io.out(program.helpInformation().replace(/\n$/, ""));
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version requests exit 0; genuine parse/usage errors map to the
      // conventional usage exit code 2 so scripts can tell a usage error apart
      // from a runtime error (1) or a 404 (4).
      return err.exitCode === 0 ? 0 : 2;
    }
    if (err instanceof DdbApiError) {
      deps.io.err(`Error: ${err.message}`);
      // A 403 on a v2 read route is unexpected (they are public). It usually
      // means --base-url was pointed at an auth-only endpoint, or the item
      // component is access-restricted; hint at that rather than a bare 403.
      if (err.status === 403) {
        deps.io.err(
          "Access denied (403). The v2 read routes (search, item, version) are public; " +
            "a 403 usually means --base-url targets an authenticated endpoint or the " +
            "requested item component is access-restricted.",
        );
      }
      // Map a few notable statuses to distinct exit codes for scripting.
      if (err.status === 404) return 4;
      return 1;
    }
    if (err instanceof DdbValidationError || err instanceof DdbUsageError) {
      // A usage error detected in an action, or the library rejecting an input
      // before any request (DdbValidationError, which extends DdbUsageError; named
      // here for clarity): exit 2, matching commander's own usage/parse errors.
      deps.io.err(`Error: ${err.message}`);
      return 2;
    }
    if (err instanceof DdbNetworkError) {
      // Transport-level failure (DNS, connection reset, timeout, size cap).
      deps.io.err(`Error: ${err.message}`);
      return 6;
    }
    if (err instanceof DdbError) {
      deps.io.err(`Error: ${err.message}`);
      return 1;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
