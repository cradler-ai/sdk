import { CradlerError } from './errors'
import type { Transport } from './http'
import type { StorageFile, UploadBody } from './types'

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
    options: { contentType?: string } = {},
  ): Promise<{ path: string }> {
    const res = await this.transport.request<{
      path: string
      upload_url: string
    }>('POST', '/storage/upload-url', { path })

    const headers: Record<string, string> = {}
    if (options.contentType) headers['content-type'] = options.contentType

    const put = await this.transport.fetchUrl(
      'PUT',
      res.upload_url,
      body,
      headers,
    )
    if (!put.ok) {
      throw new CradlerError(put.status, {
        code: 'upload_failed',
        message: `file upload failed (HTTP ${put.status})`,
      })
    }
    return { path }
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
