// Wire up all command groups onto the program.

import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { registerSearchCommand } from "./search.js";
import { registerItemCommand } from "./item.js";
import { registerCatalogCommands } from "./catalog.js";

export function registerCommands(program: Command, deps: CliDeps): void {
  registerSearchCommand(program, deps);
  registerItemCommand(program, deps);
  registerCatalogCommands(program, deps);
}
