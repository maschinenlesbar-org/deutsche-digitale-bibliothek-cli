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
import { ITEM_PARTS } from "./types.js";

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

/**
 * A value that goes into an HTTP header (`userAgent`, `defaultHeaders`): not blank,
 * no C0 control character except tab, no DEL, and nothing above U+00FF. Node's
 * HTTP layer would otherwise throw an opaque "Invalid character in header content"
 * at request time (a CR/LF could split the header). Checked by char code so the
 * source stays free of control bytes.
 */
export const headerValueProblem: Problem = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (value.trim() === "") return "Expected a non-empty value.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/** An HTTP header name: a token (RFC 9110 §5.6.2). */
export const headerNameProblem: Problem = (name) =>
  typeof name === "string" && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
    ? undefined
    : "Expected an HTTP header name (letters, digits and !#$%&'*+-.^_`|~).";

/**
 * Return `value` when it is a valid header value ({@link headerValueProblem}),
 * else throw a DdbValidationError naming the header (`Invalid <name>: …`).
 */
export function assertHeaderValue(name: string, value: string): string {
  return assertValid(name, value, headerValueProblem);
}

/**
 * A configured base URL (`baseUrl`, `--base-url`): not blank, no surrounding
 * whitespace, a parseable `http:`/`https:` URL without a query or fragment.
 * Userinfo (`https://user:pw@host/`) is allowed; it is redacted from messages.
 *
 * Surrounding whitespace is checked on the raw value: `new URL()` trims it
 * silently, but request paths are appended to the raw string, so
 * `"https://h/2 "` would request `/2%20/version`. A `?` or `#` would swallow
 * every path: `http://h/2?x=1` requests `/2?x=1/version` and `http://h/2#f`
 * requests `/2`.
 */
export const baseUrlProblem: Problem = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (value.trim() === "") return "Expected a non-empty URL.";
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Expected a valid URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Only http: and https: base URLs are supported.";
  }
  if (/[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  return undefined;
};

/**
 * An item component (`item(id, part)`): one of {@link ITEM_PARTS}. Only the
 * listed names count, so an inherited property name such as "toString" is
 * rejected too.
 */
export const itemPartProblem: Problem = (part) =>
  typeof part === "string" && (ITEM_PARTS as readonly string[]).includes(part)
    ? undefined
    : `Expected one of: ${ITEM_PARTS.join(", ")}.`;
