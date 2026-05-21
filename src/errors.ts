export interface ErrorBody {
  code: string
  message: string
  details?: unknown
}

/** Thrown for any non-2xx response from the data gateway. */
export class CradlerError extends Error {
  /** Machine-readable code, e.g. `schema_conflict`, `unauthorized`. */
  readonly code: string
  /** HTTP status (0 for network-level failures). */
  readonly status: number
  /** Optional structured detail (e.g. request-validation errors). */
  readonly details?: unknown

  constructor(status: number, body: ErrorBody) {
    super(body.message)
    this.name = 'CradlerError'
    this.code = body.code
    this.status = status
    this.details = body.details
    // Keep `instanceof` working across transpilation targets.
    Object.setPrototypeOf(this, CradlerError.prototype)
  }
}
