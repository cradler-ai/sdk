import { Transport } from './http'
import { Collection } from './query'
import { StorageClient } from './storage'
import type { ClientOptions, Row } from './types'

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
    return new Collection<T>(this.transport, collection)
  }
}

export function createClient(options: ClientOptions): CradlerClient {
  return new CradlerClient(options)
}
