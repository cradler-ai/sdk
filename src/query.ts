import { camelKeys, snakeKeys, toSnake } from './case'
import type { Transport } from './http'
import type {
  Filter,
  FilterOp,
  OrderBy,
  ResultSet,
  Row,
  SchemaResult,
} from './types'

const seg = (s: string): string => encodeURIComponent(s)

/** The valid field names of a row type — its string keys. For an untyped
 *  collection (`from('books')`) this resolves to `string`; for a typed
 *  `from<Book>('books')` a misspelled field name becomes a compile error. */
type FieldOf<T> = keyof T & string

const snakeFilters = (filters: Filter[]): Filter[] =>
  filters.map((f) => ({ ...f, field: toSnake(f.field) }))

function camelResultSet<T>(res: ResultSet<Row>): ResultSet<T> {
  const out: ResultSet<T> = {
    rows: res.rows.map((r) => camelKeys<T>(r)),
    count: res.count,
  }
  if (res.total !== undefined) out.total = res.total
  return out
}

/** A builder whose result is produced lazily and can be `await`ed directly. */
abstract class Executable<R> implements PromiseLike<R> {
  private promise?: Promise<R>

  protected abstract run(): Promise<R>

  private exec(): Promise<R> {
    if (!this.promise) this.promise = this.run()
    return this.promise
  }

  then<TResult1 = R, TResult2 = never>(
    onfulfilled?: ((value: R) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected)
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<R | TResult> {
    return this.exec().then(undefined, onrejected)
  }
}

/** Shared `.eq() / .gt() / ...` filter chain for select / update / delete.
 *  `TRow` is the row type, so filter field names are checked against it. */
abstract class Filterable<TRow, R> extends Executable<R> {
  protected readonly filters: Filter[] = []

  private add(field: string, op: FilterOp, value?: unknown): this {
    this.filters.push({ field, op, value })
    return this
  }

  eq(field: FieldOf<TRow>, value: unknown): this {
    return this.add(field, 'eq', value)
  }
  neq(field: FieldOf<TRow>, value: unknown): this {
    return this.add(field, 'neq', value)
  }
  gt(field: FieldOf<TRow>, value: unknown): this {
    return this.add(field, 'gt', value)
  }
  gte(field: FieldOf<TRow>, value: unknown): this {
    return this.add(field, 'gte', value)
  }
  lt(field: FieldOf<TRow>, value: unknown): this {
    return this.add(field, 'lt', value)
  }
  lte(field: FieldOf<TRow>, value: unknown): this {
    return this.add(field, 'lte', value)
  }
  like(field: FieldOf<TRow>, pattern: string): this {
    return this.add(field, 'like', pattern)
  }
  ilike(field: FieldOf<TRow>, pattern: string): this {
    return this.add(field, 'ilike', pattern)
  }
  in(field: FieldOf<TRow>, values: unknown[]): this {
    return this.add(field, 'in', values)
  }
  isNull(field: FieldOf<TRow>): this {
    return this.add(field, 'is_null', true)
  }
  notNull(field: FieldOf<TRow>): this {
    return this.add(field, 'is_null', false)
  }
}

/** A read query: filters + projection + ordering + pagination. */
export class SelectBuilder<T = Row> extends Filterable<T, ResultSet<T>> {
  private readonly orderBy: OrderBy[] = []
  private take?: number
  private skip?: number
  private countMode?: 'exact'

  constructor(
    private readonly transport: Transport,
    private readonly collection: string,
    private readonly columns: string[] | undefined,
  ) {
    super()
  }

  order(field: FieldOf<T>, opts: { desc?: boolean } = {}): this {
    this.orderBy.push({ field, desc: opts.desc ?? false })
    return this
  }

  limit(n: number): this {
    this.take = n
    return this
  }

  offset(n: number): this {
    this.skip = n
    return this
  }

  /** Also return `total` — how many rows match the filters overall, ignoring
   *  limit/offset. Needed for pagination, since `count` only ever reports the
   *  size of the page you got back. Costs an extra counting pass, so it is
   *  opt-in. */
  count(mode: 'exact' = 'exact'): this {
    this.countMode = mode
    return this
  }

  /** Run the query and return the first row, or null if none matched. */
  async first(): Promise<T | null> {
    this.take = 1
    const { rows } = await this.run()
    return rows[0] ?? null
  }

  protected async run(): Promise<ResultSet<T>> {
    const res = await this.transport.request<ResultSet<Row>>(
      'POST',
      `/${seg(this.collection)}/query`,
      {
        select: this.columns?.map(toSnake),
        filters: snakeFilters(this.filters),
        order: this.orderBy.map((o) => ({
          field: toSnake(o.field),
          desc: o.desc,
        })),
        ...(this.take !== undefined ? { limit: this.take } : {}),
        ...(this.skip !== undefined ? { offset: this.skip } : {}),
        ...(this.countMode !== undefined ? { count: this.countMode } : {}),
      },
    )
    return camelResultSet<T>(res)
  }
}

/** An update scoped by filters. At least one filter is required. */
export class UpdateBuilder<T = Row> extends Filterable<T, ResultSet<T>> {
  constructor(
    private readonly transport: Transport,
    private readonly collection: string,
    private readonly patch: Partial<T>,
  ) {
    super()
  }

  protected async run(): Promise<ResultSet<T>> {
    if (this.filters.length === 0) {
      return Promise.reject(
        new Error(
          'update() requires at least one filter — ' +
            'refusing to rewrite the entire collection',
        ),
      )
    }
    const res = await this.transport.request<ResultSet<Row>>(
      'POST',
      `/${seg(this.collection)}/update`,
      {
        patch: snakeKeys(this.patch as Record<string, unknown>),
        filters: snakeFilters(this.filters),
      },
    )
    return camelResultSet<T>(res)
  }
}

/** A delete scoped by filters. At least one filter is required. */
export class DeleteBuilder<T = Row> extends Filterable<T, ResultSet<T>> {
  constructor(
    private readonly transport: Transport,
    private readonly collection: string,
  ) {
    super()
  }

  protected async run(): Promise<ResultSet<T>> {
    if (this.filters.length === 0) {
      return Promise.reject(
        new Error(
          'delete() requires at least one filter — ' +
            'refusing to delete the entire collection',
        ),
      )
    }
    const res = await this.transport.request<ResultSet<Row>>(
      'POST',
      `/${seg(this.collection)}/delete`,
      { filters: snakeFilters(this.filters) },
    )
    return camelResultSet<T>(res)
  }
}

/** Entry point for operations on one collection. */
export class Collection<T = Row> {
  constructor(
    private readonly transport: Transport,
    private readonly collection: string,
  ) {}

  /** Insert one row or many. The collection and its columns auto-evolve. */
  async insert(data: Partial<T> | Partial<T>[]): Promise<ResultSet<T>> {
    const rows = (Array.isArray(data) ? data : [data]).map((d) =>
      snakeKeys(d as Record<string, unknown>),
    )
    const res = await this.transport.request<ResultSet<Row>>(
      'POST',
      `/${seg(this.collection)}`,
      rows,
    )
    return camelResultSet<T>(res)
  }

  /** Start a read query. Passing no columns selects them all. */
  select(...columns: FieldOf<T>[]): SelectBuilder<T> {
    return new SelectBuilder<T>(
      this.transport,
      this.collection,
      columns.length > 0 ? columns : undefined,
    )
  }

  /** Start an update. Chain `.eq()` etc. to scope which rows change —
   *  at least one filter is required. */
  update(patch: Partial<T>): UpdateBuilder<T> {
    return new UpdateBuilder<T>(this.transport, this.collection, patch)
  }

  /** Start a delete. At least one filter must be chained on. */
  delete(): DeleteBuilder<T> {
    return new DeleteBuilder<T>(this.transport, this.collection)
  }

  /** Inspect the schema that has emerged for this collection. */
  async schema(): Promise<SchemaResult> {
    const res = await this.transport.request<SchemaResult>(
      'GET',
      `/${seg(this.collection)}/schema`,
    )
    return {
      collection: res.collection,
      columns: camelKeys<Record<string, string>>(res.columns),
    }
  }
}
