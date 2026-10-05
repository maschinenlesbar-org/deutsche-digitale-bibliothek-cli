// Public entry point for the API client library.

export { DdbClient, DEFAULT_SEARCH_ROWS, ITEM_OPTION_KEYS, SEARCH_PARAM_KEYS, validateItemOptions } from "./client.js";
export type { DdbClientOptions } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  isTransientNetworkError,
  parseRetryAfter,
  validateBaseUrl,
} from "./engine.js";
export type { EngineOptions, RawResponse, RequestOptions } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport, sizeLimitMessage } from "./http.js";
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
  MAX_MESSAGE_URL_LENGTH,
  credentialsIn,
  messageUrl,
  redactCredentials,
  redactUrl,
} from "./errors.js";
export {
  assertHeaderValue,
  assertValid,
  baseUrlProblem,
  headerNameProblem,
  headerValueProblem,
  itemIdProblem,
  itemPartProblem,
  normalizeItemId,
  pathNameProblem,
} from "./validate.js";
export type { Problem } from "./validate.js";

export * from "./types.js";
