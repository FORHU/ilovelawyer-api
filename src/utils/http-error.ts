export default class HttpError extends Error {
  statusCode: number;
  /** Optional machine-readable reason, sent alongside `message` (see error-handler.middleware)
   * for clients that need to branch on *why* — e.g. a mind map expand hitting MAX_NODES. */
  code?: string;
  /** Further machine-readable detail sent with the message and code (e.g. which prerequisites are
   * missing), for clients that want to render more than one line. Optional; most errors carry none. */
  details?: Record<string, unknown>;

  constructor(message: string, statusCode: number, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.statusCode = statusCode;
    if (code) this.code = code;
    if (details) this.details = details;
  }
}
