export default class HttpError extends Error {
  statusCode: number;
  /** Optional machine-readable reason, sent alongside `message` (see error-handler.middleware)
   * for clients that need to branch on *why* — e.g. a mind map expand hitting MAX_NODES. */
  code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}
