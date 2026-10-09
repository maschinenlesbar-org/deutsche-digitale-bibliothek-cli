// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/**
 * Replace the userinfo of a URL (`https://user:secret@host/...`) with `***`, so a
 * credential in a base URL never reaches an error message, a log or CI output.
 * A value that does not parse as a URL (a port typo, an unencoded `#` in the
 * password) has its userinfo cut out by text ({@link credentialsIn}); a value
 * without userinfo is returned unchanged.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A value that doesn't parse can still carry credentials: cut them out by text.
    return redactCredentials(url, credentialsIn(url));
  }
  // `user:pw@host` without a scheme parses as a URL with the scheme "user:": no userinfo.
  if (parsed.username === "" && parsed.password === "") return redactCredentials(url, credentialsIn(url));
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/**
 * The userinfo a URL-like value carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. It works on values that don't
 * parse as a URL too, and on values with a prefix (`--base-url=https://u:p@h`): the userinfo
 * is everything between `://` and the last `@` before the host. A value without a scheme
 * counts when it reads `user:password@host`. Used to redact those exact strings from text
 * that echoes the value (usage errors, help), whatever characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  const schemeAt = value.indexOf("://");
  const rest = schemeAt >= 0 ? value.slice(schemeAt + 3) : value;
  // Without a scheme only the unmistakable `user:password@host` form counts.
  if (schemeAt < 0 && !/^[^\s/@:]+:[^@]*@[^@\s/]/.test(rest)) return [];
  // The URL itself starts at its scheme (`--base-url=https://…` has a prefix).
  const scheme = schemeAt >= 0 ? /[a-z][a-z0-9+.-]*$/i.exec(value.slice(0, schemeAt)) : null;
  let parses = false;
  try {
    new URL(schemeAt >= 0 ? value.slice(scheme?.index ?? schemeAt) : `http://${rest}`);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before the
  // first "/", "?" or "#"); in one that doesn't, at the last "@" of the value.
  const authority = parses ? rest.slice(0, rest.search(/[/?#]|$/)) : rest;
  const end = authority.lastIndexOf("@");
  return end > 0 ? [rest.slice(0, end)] : [];
}

/**
 * The forms in which a server may echo the credentials of a userinfo (`user:password`,
 * as {@link credentialsIn} returns it) back in an error body: the `Authorization: Basic`
 * value (base64 of the decoded `user:password`, UTF-8 as the engine sends it), the
 * decoded `user:password` itself, and the password alone when it is at least 4
 * characters long. `[]` for a userinfo without a password. None of them has an `@` to
 * anchor on, so they are replaced as exact strings ({@link redactSecrets}).
 */
export function echoedCredentialForms(userinfo: string): string[] {
  const colon = userinfo.indexOf(":");
  if (colon < 0) return [];
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const user = decode(userinfo.slice(0, colon));
  const password = decode(userinfo.slice(colon + 1));
  if (password === "") return [];
  const pair = `${user}:${password}`;
  const forms = [Buffer.from(pair, "utf8").toString("base64"), pair];
  if (password.length >= 4) forms.push(password);
  return forms;
}

/**
 * `text` with every occurrence of each secret (a form a server echoes a credential in,
 * which has no `@` to anchor on) replaced by `***`. Secrets shorter than 4 characters are
 * skipped: they are not credentials, and replacing them would garble the rest of the text.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.trim().length < 4) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/**
 * `text` with every occurrence of each credential (as {@link credentialsIn} returns them)
 * that is followed by `@` replaced by `***`. Matching the exact strings, not a pattern,
 * covers passwords with spaces, quotes, `#`, `?` or `/` that no URL pattern can delimit.
 */
export function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text;
  for (const secret of credentials) {
    if (secret === "") continue;
    out = out.split(`${secret}@`).join("***@");
  }
  return out;
}

/**
 * `text` cut to at most `max` UTF-16 units, never inside a surrogate pair: when the cut
 * would land after a high surrogate it is made one unit earlier, so a message that holds
 * the cut text is well-formed (a lone `\ud83d` makes jq reject a whole JSON stream).
 * Text no longer than `max` is returned as it is; the caller marks a cut.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

/**
 * The longest value (in characters) an own message quotes from a server answer or from
 * the user's input: a redirect target, a key, a request path. A longer one is cut
 * (`cutText`) and ends in "…", so a library caller's `err.message` stays bounded too.
 */
export const MAX_QUOTED_LENGTH = 200;

/** `text` cut to `max` characters (default `MAX_QUOTED_LENGTH`), a cut marked with "…". */
export function cutForMessage(text: string, max = MAX_QUOTED_LENGTH): string {
  const cut = cutText(text, max);
  return cut.length < text.length ? `${cut}…` : text;
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

/**
 * `text` with every lone surrogate (half of a character) replaced by U+FFFD, like
 * `String.prototype.toWellFormed` (ES2024, so not in this package's `lib`).
 */
export function toWellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/** Longest request URL an error message shows (in characters); `DdbApiError.url` keeps it all. */
export const MAX_MESSAGE_URL_LENGTH = 300;

/**
 * `url` as an error message shows it: cut at {@link MAX_MESSAGE_URL_LENGTH} characters,
 * ending in "… (N characters)". A long query or filter list (the way to hit HTTP 414)
 * otherwise put a 15 KB URL on one stderr line.
 */
export function messageUrl(url: string): string {
  return url.length > MAX_MESSAGE_URL_LENGTH
    ? `${cutText(url, MAX_MESSAGE_URL_LENGTH)}… (${url.length} characters)`
    : url;
}

/** Base class for every error originating from this client. */
export class DdbError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The API responded with a non-2xx status code. The DDB reports errors as a JSON
 * envelope `{ name, message, stacktrace }` (e.g. `NotAuthorizedException`,
 * `ItemNotFoundException`); `apiName` holds that `name` and `detail` the human
 * readable `message` when present. For a 3xx that was not followed (not a
 * followable status, a malformed Location, or past `maxRedirects`), `location`
 * holds the redirect target (absolute, sanitised, userinfo redacted) and the
 * message names it. The message cuts a long URL (`messageUrl`); `url` keeps it whole.
 */
export class DdbApiError extends DdbError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly apiName: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly location: string | undefined;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
    apiName?: string;
    location?: string;
  }) {
    // The URL is shown without userinfo: a credential in --base-url must not leak.
    const url = redactUrl(args.url);
    const parts: string[] = [];
    if (args.detail) parts.push(args.detail);
    if (args.status >= 300 && args.status < 400) {
      parts.push(
        args.location
          ? `redirect to ${cutForMessage(args.location)} not followed`
          : "redirect not followed (no Location header)",
      );
    }
    const detailPart = parts.length > 0 ? `: ${parts.join("; ")}` : "";
    super(`HTTP ${args.status} for ${args.method} ${messageUrl(url)}${detailPart}`);
    this.status = args.status;
    this.url = url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
    this.apiName = args.apiName;
    this.location = args.location;
  }

  /** True for statuses the API documents as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class DdbNetworkError extends DdbError {}

/**
 * A usage error (bad/missing argument detected before any request, e.g. `--force`
 * without `--output`). Mapped to the conventional usage exit code 2 so scripts can
 * distinguish it from a runtime error (1).
 */
export class DdbUsageError extends DdbError {}

/**
 * The library rejected an input before sending any request (message
 * `Invalid <name>: <reason>`, see `validate.ts`). It extends `DdbUsageError`, so
 * existing `instanceof DdbUsageError` checks keep catching it, and the CLI maps it
 * to the usage exit code 2.
 */
export class DdbValidationError extends DdbUsageError {}

/** The response body could not be parsed as the expected JSON shape. */
export class DdbParseError extends DdbError {}
