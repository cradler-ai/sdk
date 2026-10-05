import {
  compressImage,
  isCompressibleImage,
  rewriteExtension,
  type CompressOptions,
} from './compress'
import { CradlerError } from './errors'
import type { Transport } from './http'
import type { ImageTransform, StorageFile, UploadBody } from './types'

/**
 * Whether `v` is a Blob/File. Duck-typed rather than `instanceof Blob`: a Blob
 * from another realm (an iframe, a test DOM such as jsdom/happy-dom) or a
 * polyfill (fetch-blob, formdata-node) is not an instance of this realm's
 * global `Blob`, and some runtimes have no global `Blob` at all — where
 * `instanceof` would throw a ReferenceError.
 */
function isBlob(v: unknown): v is Blob {
  if (typeof Blob !== 'undefined' && v instanceof Blob) return true
  if (typeof v !== 'object' || v === null) return false
  const b = v as { size?: unknown; type?: unknown; arrayBuffer?: unknown }
  return (
    typeof b.size === 'number' &&
    typeof b.type === 'string' &&
    typeof b.arrayBuffer === 'function'
  )
}

/** Byte length of an upload body, for the size the upload URL is signed for. */
function byteLength(body: UploadBody): number {
  if (typeof body === 'string') return new TextEncoder().encode(body).length
  if (isBlob(body)) return body.size
  // ArrayBuffer, or any typed-array / DataView / Node Buffer.
  const n = (body as { byteLength?: unknown } | null)?.byteLength
  if (typeof n === 'number') return n
  // Anything else (a ReadableStream, a Node stream, a plain object) has no
  // known length to sign, and fetch can't send most of it anyway — fail here,
  // before an upload URL is issued, with a message that says what to pass.
  throw new CradlerError(0, {
    code: 'invalid_body',
    message:
      'storage.upload() body must be a Blob/File, an ArrayBuffer (or typed ' +
      'array / Buffer), or a string',
  })
}

/**
 * Percent-encode one path segment the way the gateway does (Python's
 * `quote(key, safe="/")`), so `getPublicUrl()` returns the very URL that
 * `upload()` reported. `encodeURIComponent` leaves `!'()*` alone; quote
 * escapes them, so do too.
 */
function encodeSegment(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

export interface UploadOptions {
  /** Override the auto-detected `Content-Type` sent to storage. */
  contentType?: string
  /**
   * Compress and re-encode image uploads in the browser before they leave
   * the device. Pass `true` for sensible defaults, or an object to tune.
   *
   * Non-image bodies and SVGs are passed through unchanged.
   *
   * When compression changes the format, the stored path's extension is
   * rewritten to match — check the returned `path` for the actual key.
   */
  compress?: boolean | CompressOptions
  /**
   * Store the file in the public, CDN-fronted bucket. Public files are loaded
   * directly from a stable URL (`getPublicUrl`) with no round trip and no
   * signature — fast and edge-cached. Use for avatars, post images, anything
   * meant to be world-readable. Defaults to `false` (private, signed URLs).
   */
  public?: boolean
}

/**
 * File storage for a project — upload, download, list and delete files.
 *
 * Uploads and downloads go directly to object storage via presigned URLs; the
 * file bytes never pass through the data gateway.
 */
export class StorageClient {
  constructor(private readonly transport: Transport) {}

  // The public base (`<custom-domain>/<projectId>`) is fetched once from the
  // gateway and cached, so `getPublicUrl` builds URLs with no per-call round
  // trip. `null` once fetched means public storage isn't configured.
  private publicBase: Promise<string | null> | undefined

  /** Upload a file. Resolves once the bytes are stored.
   *
   * For a public upload, the result also includes `publicUrl` — a stable,
   * CDN-cached URL you can store and render directly.
   */
  async upload(
    path: string,
    body: UploadBody,
    options: UploadOptions = {},
  ): Promise<{ path: string; publicUrl?: string }> {
    let finalPath = path
    let finalBody: UploadBody = body
    let detectedType: string | undefined

    if (options.compress && isBlob(body) && isCompressibleImage(body)) {
      const compressOpts =
        options.compress === true ? {} : options.compress
      const format = compressOpts.format ?? 'webp'
      const compressed = await compressImage(body, compressOpts)
      if (compressed !== body) {
        finalBody = compressed
        finalPath = rewriteExtension(path, format)
        detectedType = compressed.type
      }
    }

    const res = await this.transport.request<{
      path: string
      upload_url: string
      public_url?: string
    }>('POST', '/storage/upload-url', {
      path: finalPath,
      public: options.public ?? false,
      // Declared up front so the upload URL is signed for exactly this many
      // bytes — the bucket then rejects anything larger. Uploads go straight
      // to storage, so this is the only point at which a size limit can bind.
      size: byteLength(finalBody),
    })

    const headers: Record<string, string> = {}
    const contentType =
      options.contentType ??
      detectedType ??
      (isBlob(finalBody) && finalBody.type ? finalBody.type : undefined)
    if (contentType) headers['content-type'] = contentType

    const put = await this.transport.fetchUrl(
      'PUT',
      res.upload_url,
      finalBody,
      headers,
    )
    if (!put.ok) {
      throw new CradlerError(put.status, {
        code: 'upload_failed',
        message: `file upload failed (HTTP ${put.status})`,
      })
    }
    return res.public_url
      ? { path: finalPath, publicUrl: res.public_url }
      : { path: finalPath }
  }

  /**
   * A stable, CDN-cached URL for a PUBLIC file (one uploaded with
   * `{ public: true }`). No signature, no expiry, no round trip after the
   * first call. Pass `transform` to have the edge serve a resized, re-encoded
   * variant — ideal for thumbnails in a feed.
   *
   * Throws if public storage isn't configured for this deployment.
   */
  async getPublicUrl(
    path: string,
    transform?: ImageTransform,
  ): Promise<string> {
    const base = await this.resolvePublicBase()
    if (!base) {
      throw new CradlerError(0, {
        code: 'public_storage_disabled',
        message: 'public storage is not configured for this project',
      })
    }
    // Same normalisation as the gateway's object key (trim, drop leading
    // slashes), then encode each segment: a raw `#`, `?` or `%` in a file name
    // would otherwise cut the URL short or be decoded into a different key.
    const objectPath = path
      .trim()
      .replace(/^\/+/, '')
      .split('/')
      .map(encodeSegment)
      .join('/')
    const u = new URL(base) // e.g. https://files.cradler.ai/<projectId>
    const prefix = u.pathname.replace(/^\/+|\/+$/g, '')
    const fullKey = prefix ? `${prefix}/${objectPath}` : objectPath
    const opts = transformOptions(transform)
    return opts
      ? `${u.origin}/cdn-cgi/image/${opts}/${fullKey}`
      : `${u.origin}/${fullKey}`
  }

  private resolvePublicBase(): Promise<string | null> {
    if (!this.publicBase) {
      this.publicBase = this.transport
        .request<{ public_enabled: boolean; public_url: string | null }>(
          'GET',
          '/storage/config',
        )
        .then((c) => (c.public_enabled ? c.public_url : null))
        .catch((err) => {
          // Don't cache a transient failure — let the next call retry.
          this.publicBase = undefined
          throw err
        })
    }
    return this.publicBase
  }

  /** A temporary, signed URL for downloading a PRIVATE file directly. */
  async getUrl(path: string): Promise<string> {
    const res = await this.transport.request<{
      path: string
      download_url: string
    }>('POST', '/storage/download-url', { path })
    return res.download_url
  }

  /** Download a file's contents as a Blob. */
  async download(path: string): Promise<Blob> {
    const url = await this.getUrl(path)
    const res = await this.transport.fetchUrl('GET', url)
    if (!res.ok) {
      throw new CradlerError(res.status, {
        code: 'download_failed',
        message: `file download failed (HTTP ${res.status})`,
      })
    }
    return res.blob()
  }

  /** List stored files, optionally under a path prefix. Pass
   * `{ public: true }` to list the public bucket instead of the private one. */
  async list(
    prefix = '',
    options: { public?: boolean } = {},
  ): Promise<StorageFile[]> {
    const params = new URLSearchParams()
    if (prefix) params.set('prefix', prefix)
    if (options.public) params.set('public', 'true')
    const query = params.toString()
    const res = await this.transport.request<{
      files: Array<{ path: string; size: number; last_modified: string }>
    }>('GET', `/storage/list${query ? `?${query}` : ''}`)
    return res.files.map((f) => ({
      path: f.path,
      size: f.size,
      lastModified: f.last_modified,
    }))
  }

  /** Delete a file. Pass `{ public: true }` for a file stored as public. */
  async remove(
    path: string,
    options: { public?: boolean } = {},
  ): Promise<void> {
    await this.transport.request('POST', '/storage/delete', {
      path,
      public: options.public ?? false,
    })
  }
}

/** Serialize image-transform options into a Cloudflare `/cdn-cgi/image/`
 * option string, or `''` when there's nothing to transform. */
function transformOptions(t?: ImageTransform): string {
  if (!t) return ''
  const parts: string[] = []
  if (t.width) parts.push(`width=${t.width}`)
  if (t.height) parts.push(`height=${t.height}`)
  if (t.quality) parts.push(`quality=${t.quality}`)
  if (parts.length === 0) return ''
  parts.push('format=auto') // edge picks webp/avif per the client
  return parts.join(',')
}
