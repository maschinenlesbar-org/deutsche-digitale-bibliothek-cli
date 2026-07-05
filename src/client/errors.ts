// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

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
 * readable `message` when present.
 */
export class DdbApiError extends DdbError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly apiName: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
    apiName?: string;
  }) {
    const detailPart = args.detail ? `: ${args.detail}` : "";
    super(`HTTP ${args.status} for ${args.method} ${args.url}${detailPart}`);
    this.status = args.status;
    this.url = args.url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
    this.apiName = args.apiName;
  }

  /** True for statuses the API documents as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class DdbNetworkError extends DdbError {}

/**
 * A CLI usage error (bad/missing argument detected after commander parsing, e.g.
 * an item id of the wrong length). Mapped to the conventional usage exit code 2
 * so scripts can distinguish it from a runtime error (1).
 */
export class DdbUsageError extends DdbError {}

/** The response body could not be parsed as the expected JSON shape. */
export class DdbParseError extends DdbError {}
