import { CradlerError } from './errors'
import type { ClientOptions, UploadBody } from './types'

/** Low-level HTTP transport to the data gateway. */
export class Transport {
  private readonly base: string
  private readonly apiKey: string
  private readonly fetchFn: typeof fetch

  constructor(options: ClientOptions) {
    const url = options.url.replace(/\/+$/, '')
    this.base = `${url}/v1/${encodeURIComponent(options.projectId)}`
    this.apiKey = options.apiKey
    const fetchFn = options.fetch ?? globalThis.fetch
    if (typeof fetchFn !== 'function') {
      throw new Error('no global fetch found — pass `fetch` in client options')
    }
    this.fetchFn = fetchFn
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { apikey: this.apiKey }
    if (body !== undefined) headers['content-type'] = 'application/json'

    let response: Response
    try {
      response = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (cause) {
      throw new CradlerError(0, {
        code: 'network_error',
        message: `request to cradler failed: ${(cause as Error).message}`,
      })
    }

    const raw = await response.text()
    let parsed: unknown
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new CradlerError(response.status, {
          code: response.ok ? 'bad_response' : 'http_error',
          message: response.ok
            ? 'the gateway returned a non-JSON response'
            : `HTTP ${response.status}`,
        })
      }
    }

    if (!response.ok) {
      const error = (parsed as { error?: unknown } | undefined)?.error
      throw new CradlerError(
        response.status,
        isErrorBody(error)
          ? error
          : { code: 'http_error', message: `HTTP ${response.status}` },
      )
    }

    return parsed as T
  }

  /**
   * Raw fetch to an absolute URL — no base path, no API key. Used for
   * presigned storage URLs, where the client talks straight to object storage.
   */
  async fetchUrl(
    method: string,
    url: string,
    body?: UploadBody,
    headers?: Record<string, string>,
  ): Promise<Response> {
    try {
      return await this.fetchFn(url, { method, body, headers })
    } catch (cause) {
      throw new CradlerError(0, {
        code: 'network_error',
        message: `storage request failed: ${(cause as Error).message}`,
      })
    }
  }
}

function isErrorBody(v: unknown): v is { code: string; message: string } {
  if (typeof v !== 'object' || v === null) return false
  const obj = v as Record<string, unknown>
  return typeof obj.code === 'string' && typeof obj.message === 'string'
}
