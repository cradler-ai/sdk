import {
  compressImage,
  isCompressibleImage,
  rewriteExtension,
  type CompressOptions,
} from './compress'
import { CradlerError } from './errors'
import type { Transport } from './http'
import type { StorageFile, UploadBody } from './types'

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
}

/**
 * File storage for a project — upload, download, list and delete files.
 *
 * Uploads and downloads go directly to object storage via presigned URLs; the
 * file bytes never pass through the data gateway.
 */
export class StorageClient {
  constructor(private readonly transport: Transport) {}

  /** Upload a file. Resolves once the bytes are stored. */
  async upload(
    path: string,
    body: UploadBody,
    options: UploadOptions = {},
  ): Promise<{ path: string }> {
    let finalPath = path
    let finalBody: UploadBody = body
    let detectedType: string | undefined

    if (options.compress && body instanceof Blob && isCompressibleImage(body)) {
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
    }>('POST', '/storage/upload-url', { path: finalPath })

    const headers: Record<string, string> = {}
    const contentType =
      options.contentType ??
      detectedType ??
      (finalBody instanceof Blob ? finalBody.type : undefined)
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
    return { path: finalPath }
  }

  /** A temporary, signed URL for downloading the file directly. */
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

  /** List stored files, optionally under a path prefix. */
  async list(prefix = ''): Promise<StorageFile[]> {
    const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''
    const res = await this.transport.request<{
      files: Array<{ path: string; size: number; last_modified: string }>
    }>('GET', `/storage/list${query}`)
    return res.files.map((f) => ({
      path: f.path,
      size: f.size,
      lastModified: f.last_modified,
    }))
  }

  /** Delete a file. */
  async remove(path: string): Promise<void> {
    await this.transport.request('POST', '/storage/delete', { path })
  }
}
