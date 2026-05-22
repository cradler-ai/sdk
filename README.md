# @cradler/sdk

The typed TypeScript client for [Cradler](https://cradler.ai) — a zero-config
backend (a managed PostgreSQL database **and** file storage) for apps built
with AI. No SQL, no migrations: write data and the tables and columns are
created for you.

Zero runtime dependencies — it only uses the platform `fetch`.

## Install

```sh
pnpm add @cradler/sdk
```

## Setup

Create a project in the [Cradler dashboard](https://cradler.ai) — it gives you
an **API URL**, a **project ID**, and two keys (`anon` and `service`). Pass
them to `createClient`:

```ts
import { createClient } from "@cradler/sdk";

const cradler = createClient({
  url: "https://gateway.cradler.ai",
  projectId: "your-project-id",
  apiKey: process.env.CRADLER_API_KEY!,
});
```

Use the **`service`** key only in server-side code. Use the **`anon`** key in
the browser — it is limited by the table permissions you set in the dashboard.
Never hardcode keys; read them from environment variables.

## Reading and writing data

A collection is a table. You never create one — it appears the first time you
write to it. Use plain `camelCase` field names; the SDK maps them to the
database.

```ts
// Insert — the "books" table and its columns are created automatically
await cradler.from("books").insert({ title: "Dune", year: 1965, inStock: true });

// Insert many at once
await cradler.from("books").insert([{ title: "A" }, { title: "B" }]);

// Query — chainable, await directly
const { rows, count } = await cradler
  .from("books")
  .select("title", "year")
  .gte("year", 1950)
  .order("year", { desc: true })
  .limit(10);

// A single row, or null
const book = await cradler.from("books").select().eq("id", id).first();

// Update / delete — delete requires at least one filter
await cradler.from("books").update({ inStock: false }).eq("id", id);
await cradler.from("books").delete().eq("id", id);
```

Every insert / query / update / delete resolves to `{ rows, count }`.

Pass a row type for full typing: `cradler.from<Book>("books")` — filter,
order, and select field names are then checked against `Book` at compile
time, so a misspelled field is caught before the call ever runs.

### Reserved fields

Every row automatically has three Cradler-managed fields — read them, but
never set them:

- **`id`** — a unique identifier, generated on insert.
- **`createdAt`** — when the row was created.
- **`updatedAt`** — updated on every change.

You can filter and order by them, but any `id` / `createdAt` / `updatedAt`
you pass to `insert()` or `update()` is ignored — Cradler always sets them.

### Filters

Chain as many as you need:

`eq` · `neq` · `gt` · `gte` · `lt` · `lte` · `like` · `ilike` · `in` ·
`isNull` · `notNull`

## Files and images

```ts
// Upload — body is a Blob, ArrayBuffer, or string
await cradler.storage.upload("covers/dune.png", file, {
  contentType: "image/png",
});

// A temporary signed URL to display or download the file
const url = await cradler.storage.getUrl("covers/dune.png");

// Download as a Blob
const blob = await cradler.storage.download("covers/dune.png");

// List (optionally by prefix) and delete
const files = await cradler.storage.list("covers/");
await cradler.storage.remove("covers/dune.png");
```

## Errors

Any non-2xx response throws a `CradlerError` with `.status`, `.code` and
`.message` — for example `schema_conflict` when a value clashes with a
column's type.

```ts
import { CradlerError } from "@cradler/sdk";

try {
  await cradler.from("books").insert({ year: "not a number" });
} catch (err) {
  if (err instanceof CradlerError) {
    console.error(err.status, err.code, err.message);
  }
}
```

## Related

- **[`@cradler/mcp`](https://www.npmjs.com/package/@cradler/mcp)** — an MCP
  server that lets AI agents read and write a Cradler project's data directly.

## License

MIT
