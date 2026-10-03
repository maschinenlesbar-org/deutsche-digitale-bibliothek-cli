// Input validation shared by the library and the CLI. Every rule about what a
// request may contain lives in src/client as a pure, exported function, so the
// CLI calls the very same rule instead of keeping a copy.
//
// - A `Problem` returns the reason a value is invalid ("Expected a non-empty
//   value."), or `undefined` when it is valid. The CLI's commander parsers turn
//   that reason into an `InvalidArgumentError` (exit 2).
// - `assertValid` runs a `Problem` in the library and throws a
//   `DdbValidationError` ("Invalid <name>: <reason>") before any request is made.
//   Methods that return a promise call it inside the async body, so they reject
//   rather than throw synchronously; constructors throw.

import { DdbValidationError } from "./errors.js";

/** A validation rule: the reason `value` is invalid, or `undefined` when it is valid. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Check `value` against `problem` and return it unchanged when it is valid.
 * Otherwise throw a {@link DdbValidationError} with the message
 * `Invalid <name>: <reason>`.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new DdbValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/**
 * A DDB item id is exactly 32 upper-case letters and digits (`[A-Z0-9]{32}`). Ids
 * are case sensitive upstream, so a lower-cased paste gets the upper-case form as
 * a hint. Checks the value as given; {@link normalizeItemId} trims it first.
 */
export const itemIdProblem: Problem = (id) => {
  if (typeof id !== "string") return "Expected a string.";
  if (id.length !== 32) {
    return `Expected exactly 32 characters (got ${id.length}). Copy the \`id\` from a search result.`;
  }
  if (/^[A-Z0-9]{32}$/.test(id)) return undefined;
  return /^[A-Za-z0-9]{32}$/.test(id)
    ? `Item ids are upper case: try "${id.toUpperCase()}".`
    : "Expected 32 upper-case letters and digits (A-Z, 0-9). Copy the `id` from a search result.";
};

/**
 * The canonical form of an item id: surrounding whitespace (a copy-paste, `$(...)`,
 * a CSV cell) trimmed, then checked with {@link itemIdProblem}. Throws a
 * DdbValidationError (`Invalid id: …`) for anything else. Idempotent.
 */
export function normalizeItemId(id: string): string {
  return assertValid("id", typeof id === "string" ? id.trim() : id, itemIdProblem);
}

/**
 * A Solr collection or request-handler name (`search({ collection,
 * requestHandler })`): letters, digits, `.`, `_` and `-` only. These go into the
 * request path, so anything else (a `/`, `?`, space or non-ASCII letter) cannot
 * name a Solr core or handler. "." and ".." are rejected too: URL parsing would
 * resolve them as dot segments and leave the route.
 */
export const pathNameProblem: Problem = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return "Expected letters, digits, '.', '_' or '-' only.";
  if (value === "." || value === "..") return '"." and ".." are path navigation, not a name.';
  return undefined;
};
