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

import { DdbValidationError, quoteValue } from "./errors.js";
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
 * a hint. The {@link tokenProblem} rules come first, so an invisible character is named
 * (escaped) rather than counted. Checks the value as given; {@link normalizeItemId} trims it
 * first.
 */
export const itemIdProblem: Problem = (id) => {
  const token = tokenProblem(id);
  if (token !== undefined) return token;
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
 * A query or filter as the index matches it: without surrounding whitespace (U+00A0
 * included; a value pasted with a trailing no-break space was another facet value and
 * matched nothing) and in composed Unicode, NFC (a `München` pasted with a combining
 * umlaut found 231 documents instead of 2.77 million, as a facet filter none). Inner
 * whitespace is kept, and so is a trailing space Solr escapes (`label:foo\ `), which
 * belongs to the term. Idempotent.
 */
export function normalizeText(value: string): string {
  const start = value.length - value.trimStart().length;
  let end = value.trimEnd().length;
  let backslashes = 0;
  while (end - backslashes - 1 >= start && value[end - backslashes - 1] === "\\") backslashes += 1;
  if (backslashes % 2 === 1 && end < value.length) end += 1;
  return value.slice(start, end).normalize("NFC");
}

/**
 * A Solr collection or request-handler name (`search({ collection,
 * requestHandler })`): a token ({@link tokenProblem}; sent trimmed, `normalizeToken`) of
 * letters, digits, `.`, `_` and `-` only. These go into the request path, so anything else
 * (a `/`, `?`, inner space or non-ASCII letter) cannot name a Solr core or handler. "." and
 * ".." are rejected too: URL parsing would resolve them as dot segments and leave the route.
 */
export const pathNameProblem: Problem = (value) => {
  const token = tokenProblem(value);
  if (token !== undefined) return token;
  const name = (value as string).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return "Expected letters, digits, '.', '_' or '-' only.";
  if (name === "." || name === "..") return '"." and ".." are path navigation, not a name.';
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
 * Userinfo (`https://user:pw@host/`) is allowed; it is redacted from messages and sent
 * as Basic auth, so a `%` in it must start a valid escape (`%25` for a literal one).
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
  // The userinfo is percent-decoded for the Authorization header; a "%" that isn't an
  // escape would fail there ("URI malformed") at request time. Reject it here.
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return undefined;
};

/**
 * An item component (`item(id, part)`): a token ({@link tokenProblem}) that is, trimmed
 * (`normalizeToken`), one of {@link ITEM_PARTS}. Only the listed names count, so an inherited
 * property name such as "toString" is rejected too.
 */
export const itemPartProblem: Problem = (part) => {
  if (typeof part !== "string") return `Expected one of: ${ITEM_PARTS.join(", ")}.`;
  const token = tokenProblem(part);
  if (token !== undefined) return token;
  return (ITEM_PARTS as readonly string[]).includes(normalizeToken(part))
    ? undefined
    : `Expected one of: ${ITEM_PARTS.join(", ")}.`;
};

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which URLSearchParams would send as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace, control and
 * format characters (a zero-width space, a soft hyphen) and combining marks. Such a value reads
 * as "no filter" upstream, or matches nothing, so it is refused as blank.
 */
function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a text filter: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text filter, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![‌‍])\p{Cf}/u;

/**
 * Why `value` cannot be sent as a text filter (the Solr query, a filter query), or undefined
 * when it can. Refused, before any request, as the index would match nothing or everything:
 * - a value that is blank once trimmed (Unicode whitespace, U+00A0 included), or that holds only
 *   invisible characters and combining marks (`isBlank`): an empty `q`/`fq` reads as "no
 *   filter", or matches nothing;
 * - a lone surrogate (half of a character, sent as U+FFFD);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen, a bidi control; ZWNJ and ZWJ are allowed): pasted along, it makes the search find
 *   nothing.
 * The reason quotes the value with every invisible character escaped (`quoteValue`).
 */
export const textProblem: Problem = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
};

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is an id, a code, an
 * enum value, a field name or a sort key: a value the API compares exactly. The rules apply to
 * the value with surrounding whitespace trimmed, as it is sent ({@link normalizeToken}): not
 * blank (and not only invisible characters or combining marks), no lone surrogate, and no
 * control or format character at all (a zero-width space, ZWJ, a soft hyphen, a bidi control),
 * since an invisible character in an id or a field name only ever makes it match nothing. The
 * reason quotes the value visibly.
 */
export const tokenProblem: Problem = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
};

/** A token as it is sent: trimmed and in composed Unicode (NFC). Check it with {@link tokenProblem} first. */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * The clauses of a Solr sort, split at the commas outside parentheses (a function such as
 * `sum(a_i,b_i) desc` is one clause).
 */
function sortClauses(sort: string): string[] {
  const clauses: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < sort.length; i++) {
    const c = sort[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      clauses.push(sort.slice(from, i));
      from = i + 1;
    }
  }
  clauses.push(sort.slice(from));
  return clauses;
}

/**
 * A Solr sort (`search({ sort })`, `--sort`): a token ({@link tokenProblem}; sent trimmed) of
 * comma-separated clauses, each `<field or function> asc|desc`, the documented syntax. Solr
 * answers a clause without a direction ("score") or an empty one with an error status; refused
 * here before any request instead.
 */
export const sortProblem: Problem = (value) => {
  const token = tokenProblem(value);
  if (token !== undefined) return token;
  const sort = normalizeToken(value as string);
  if (sortClauses(sort).some((clause) => !/^\S.*\s(?:asc|desc)$/i.test(clause.trim()))) {
    return `${quoteValue(sort)}: a Solr sort is "<field> asc|desc", comma-separated, e.g. "score desc" or "id asc".`;
  }
  return undefined;
};

/**
 * A Solr facet field (`search({ facetFields })`, `--facet`): a token ({@link tokenProblem}; sent
 * trimmed) that names a field: letters, digits, `_`, `.`, `-` and `*`, optionally after Solr local
 * params (`{!key=types}type_fct`), and not `.` or `..`. Anything else (a space, a `/`, a `?`) names
 * no field, and Solr answers it with an error status ("undefined field").
 */
export const facetFieldProblem: Problem = (value) => {
  const token = tokenProblem(value);
  if (token !== undefined) return token;
  const field = normalizeToken(value as string);
  if (field === "." || field === ".." || !/^(?:\{![^}]*\})?[\p{L}\p{N}_.*-]+$/u.test(field)) {
    return `${quoteValue(field)}: expected a field name (letters, digits, '_', '.', '-'), e.g. "type_fct".`;
  }
  return undefined;
};

/**
 * A Solr field list (`search({ fields })`, `--fields`, `fl`): comma-separated field names, each a
 * token ({@link listProblem} over {@link splitList}; an empty item is refused, never dropped).
 * Sent as {@link normalizeFields} gives it.
 */
export const fieldsProblem: Problem = (value) => (typeof value === "string" ? listProblem(splitList(value)) : "Expected a string.");

/** A field list as it is sent: each item trimmed and in NFC, joined with commas (`" id , label "` is `id,label`). */
export function normalizeFields(value: string): string {
  return splitList(value).map(normalizeToken).join(",");
}

/**
 * The items of a comma-separated list (`--fields id,label`), as typed: each item is checked
 * (`listProblem`) and canonicalised (`normalizeToken`) on its own, so `"id, label"` sends `label`,
 * and `"id,,label"`, `"id,"` and `","` are refused rather than sent with an empty item.
 */
export function splitList(value: string): string[] {
  return value.split(",");
}

/**
 * Why `items` cannot be sent as a list, or undefined when it can: not an array of strings, no
 * item at all, or an item that `itemProblem` refuses (by default {@link tokenProblem}: a blank
 * item is refused, never dropped). The reason names the item.
 */
export function listProblem(items: readonly string[], itemProblem: Problem = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list of strings.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i] as string);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
  return undefined;
}

