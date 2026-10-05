export interface ErrorBody {
  code: string
  message: string
  details?: unknown
  /** The gateway's id for the failed request (wire name `request_id`). */
  request_id?: string
}

/** Thrown for any non-2xx response from the data gateway. */
export class CradlerError extends Error {
  /** Machine-readable code, e.g. `schema_conflict`, `unauthorized`. */
  readonly code: string
  /** HTTP status (0 for network-level failures). */
  readonly status: number
  /** Optional structured detail (e.g. request-validation errors). */
  readonly details?: unknown
  /** The gateway's id for this request. The same id is in Cradler's server
   *  logs, so include it when reporting a problem. Absent for failures that
   *  never reached the gateway (network errors, client-side checks). */
  readonly requestId?: string

  constructor(status: number, body: ErrorBody) {
    super(body.message)
    this.name = 'CradlerError'
    this.code = body.code
    this.status = status
    this.details = body.details
    if (typeof body.request_id === 'string') this.requestId = body.request_id
    // Keep `instanceof` working across transpilation targets.
    Object.setPrototypeOf(this, CradlerError.prototype)
  }
}
