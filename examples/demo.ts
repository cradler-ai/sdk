/**
 * cradler SDK demo.
 *
 * Start Postgres and the data gateway first (see cradler-sql-sev/README.md),
 * then run:  pnpm demo
 */
import { createClient, CradlerError } from '../src/index'

interface Book {
  id: string
  title: string
  year: number
  inStock: boolean
  rating?: number
}

const db = createClient({
  url: 'http://localhost:8000',
  projectId: 'demo',
  apiKey: 'service_demo_key_change_me',
})

async function main(): Promise<void> {
  // Start clean so the demo is repeatable (no-op if 'books' does not exist).
  await db.from('books').delete().gte('year', 0).catch(() => {})

  // 1. Insert — the 'books' collection and its columns are created on the fly.
  const created = await db.from<Book>('books').insert({
    title: 'The Pragmatic Programmer',
    year: 1999,
    inStock: true,
  })
  console.log('1. inserted:', created.rows)

  // 2. Insert a batch carrying an extra field — 'rating' is auto-added.
  await db.from<Book>('books').insert([
    { title: 'Designing Data-Intensive Applications', year: 2017, inStock: true, rating: 5 },
    { title: 'An Old Title', year: 1980, inStock: false, rating: 3 },
  ])

  // 3. Query — chainable builder, awaited directly.
  const recent = await db
    .from<Book>('books')
    .select('title', 'year', 'rating')
    .gte('year', 1999)
    .order('year', { desc: true })
  console.log('3. books from 1999 on:', recent.rows)

  // 4. Update rows that match a filter.
  const updated = await db
    .from<Book>('books')
    .update({ inStock: false })
    .eq('title', 'The Pragmatic Programmer')
  console.log('4. updated rows:', updated.count)

  // 5. Fetch a single row.
  const one = await db.from<Book>('books').select().eq('year', 2017).first()
  console.log('5. one book:', one)

  // 6. Inspect the schema that emerged — no migration was ever run.
  const schema = await db.from('books').schema()
  console.log('6. emerged schema:', schema.columns)

  // 7. Typed errors. A typed collection would reject this at compile time;
  //    we go untyped here to show the runtime schema guard.
  try {
    await db.from('books').insert({ year: 'not-a-number' })
  } catch (err) {
    if (err instanceof CradlerError) {
      console.log(`7. caught CradlerError -> [${err.code}] ${err.message}`)
    } else {
      throw err
    }
  }
}

main().catch((err: unknown) => {
  console.error('demo failed:', err)
  process.exit(1)
})
