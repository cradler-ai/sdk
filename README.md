# @cradler/sdk

Typed TypeScript client for the cradler data API. Zero runtime dependencies —
it only uses the platform `fetch`.

## Usage

```ts
import { createClient } from '@cradler/sdk'

const db = createClient({
  url: 'http://localhost:8000',
  projectId: 'demo',
  apiKey: 'service_demo_key_change_me',
})

// insert — the collection and its columns are created on the fly
await db.from('books').insert({ title: 'Dune', year: 1965 })

// query — chainable, await directly
const { rows } = await db
  .from('books')
  .select('title', 'year')
  .gte('year', 1950)
  .order('year', { desc: true })
  .limit(10)

// a single row
const book = await db.from('books').select().eq('id', id).first()

// update / delete  (delete requires at least one filter)
await db.from('books').update({ year: 1966 }).eq('id', id)
await db.from('books').delete().eq('id', id)
```

Pass a row type for full typing: `db.from<Book>('books')`.

## Filters

`eq` · `neq` · `gt` · `gte` · `lt` · `lte` · `like` · `ilike` · `in` ·
`isNull` · `notNull`

## Errors

Any non-2xx response throws a `CradlerError` with `.code`, `.status` and
`.message` — e.g. `schema_conflict` when a value clashes with a column's type.

## Scripts

- `pnpm build` — bundle to `dist/` (ESM + CJS + type declarations)
- `pnpm typecheck` — type-check without emitting
- `pnpm demo` — run `examples/demo.ts` against a local gateway
