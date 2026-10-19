import { camelKeys, toSnake } from './case'
import { Transport } from './http'
import { Collection } from './query'
import { StorageClient } from './storage'
import type { ClientOptions, Row, SchemaResult } from './types'

/** The cradler client. Create one with `createClient()`. */
export class CradlerClient {
  private readonly transport: Transport

  /** File storage — upload, download, list and delete files. */
  readonly storage: StorageClient

  constructor(options: ClientOptions) {
    this.transport = new Transport(options)
    this.storage = new StorageClient(this.transport)
  }

  /**
   * Access a collection. Pass a row type for full typing:
   * `client.from<Book>('books')`.
   */
  from<T = Row>(collection: string): Collection<T> {
    // Collections are snake_case like columns; `from('lifeItems')` used to be
    // rejected outright, while camelCase field names were converted.
    return new Collection<T>(this.transport, toSnake(collection))
  }

  /** Every collection in the project, with its columns. With an `anon` key,
   *  only the collections that key is allowed to read. */
  async listCollections(): Promise<SchemaResult[]> {
    const res = await this.transport.request<{ collections: SchemaResult[] }>(
      'GET',
      '/collections',
    )
    return res.collections.map((c) => ({
      collection: c.collection,
      columns: camelKeys<Record<string, string>>(c.columns),
    }))
  }
}

export function createClient(options: ClientOptions): CradlerClient {
  return new CradlerClient(options)
}
