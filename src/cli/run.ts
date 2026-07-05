// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import { DdbApiError, DdbError, DdbNetworkError, DdbUsageError } from "../client/errors.js";

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
  for (const child of command.commands) configureTree(child, deps);
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
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
      // A 403 is almost always a key problem. No key is bundled, so the request
      // likely went out with no Authorization header (or one whose security
      // level is too low); point the user at how to supply a key rather than
      // leaving them with a bare 403.
      if (err.status === 403) {
        deps.io.err(
          "Access denied (403). The DDB API requires an API key. Pass --api-key <key> " +
            "or set DDB_API_KEY. A free personal key is available from a \"Mein DDB\" " +
            "account — see the README.",
        );
      }
      // Map a few notable statuses to distinct exit codes for scripting.
      if (err.status === 404) return 4;
      return 1;
    }
    if (err instanceof DdbUsageError) {
      // A usage error detected in an action (e.g. an item id of the wrong
      // length): exit 2, matching commander's own usage/parse errors.
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
