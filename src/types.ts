/** Public types for the cradler SDK. */

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | 'ilike'
  | 'in'
  | 'is_null'

export interface Filter {
  field: string
  op: FilterOp
  value?: unknown
}

export interface OrderBy {
  field: string
  desc: boolean
}

/** A generic data row, used when no project-specific type is supplied. */
export type Row = Record<string, unknown>

/** The result of any insert / query / update / delete. */
export interface ResultSet<T = Row> {
  rows: T[]
  count: number
}

/** The columns a collection currently has (auto-evolved by the gateway). */
export interface SchemaResult {
  collection: string
  columns: Record<string, string>
}

export interface ClientOptions {
  /** Base URL of the data gateway, e.g. `http://localhost:8000`. */
  url: string
  /** Project identifier. */
  projectId: string
  /** Project API key (`anon` or `service`). */
  apiKey: string
  /** Optional `fetch` implementation (defaults to the global `fetch`). */
  fetch?: typeof fetch
}

/** A stored file, as returned by `storage.list()`. */
export interface StorageFile {
  path: string
  size: number
  lastModified: string
}

/** Edge image-resize options for a public file's URL (Cloudflare-powered). */
export interface ImageTransform {
  /** Target width in pixels. */
  width?: number
  /** Target height in pixels. */
  height?: number
  /** Output quality, 1–100 (default ~85). */
  quality?: number
}

/** Accepted file-content types for `storage.upload()`. */
export type UploadBody = Blob | ArrayBuffer | string
