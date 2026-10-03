// Public entry point for the API client library.

export { DdbClient, DEFAULT_SEARCH_ROWS, validateItemOptions } from "./client.js";
export type { DdbClientOptions } from "./client.js";
export { RequestEngine, DEFAULT_BASE_URL, MAX_RETRIES, MAX_RETRY_AFTER_MS, parseRetryAfter } from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  DdbError,
  DdbApiError,
  DdbNetworkError,
  DdbParseError,
  DdbUsageError,
  DdbValidationError,
  redactUrl,
} from "./errors.js";
export {
  assertHeaderValue,
  assertValid,
  headerNameProblem,
  headerValueProblem,
  itemIdProblem,
  normalizeItemId,
  pathNameProblem,
} from "./validate.js";
export type { Problem } from "./validate.js";

export * from "./types.js";
