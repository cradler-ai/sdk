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

// Update / delete — both require at least one filter
await cradler.from("books").update({ inStock: false }).eq("id", id);
await cradler.from("books").delete().eq("id", id);
```

Every insert / query / update / delete resolves to `{ rows, count }`, where
`count` is `rows.length`.

A query returns **at most 50 rows unless you call `.limit()`** (maximum
1000 per call); page with `.limit()` + `.offset()`. `count` is the size of
the page, not how many rows match — chain `.count("exact")` and read
`total` for that:

```ts
const { rows, total } = await cradler.from("books").select().limit(20).count("exact");
```

Pass a row type for full typing: `cradler.from<Book>("books")` — filter,
order, and select field names are then checked against `Book` at compile
time, so a misspelled field is caught before the call ever runs.

### Upsert and unique fields

Checking "does it exist?" and then inserting races: two requests can both
see nothing and both insert. Let the database decide instead:

```ts
// Insert, or update the row with the same email. Only the fields you pass
// are updated; the rest keep their stored values.
await cradler.from("users").upsert(
  { email, name },
  { onConflict: "email" },
);

// "Insert unless it exists" — idempotent writes. A stored row is returned
// unchanged, so a retry gets the original back.
const { rows: [post] } = await cradler.from("posts").upsert(
  { idempotencyKey, text },
  { onConflict: "idempotencyKey", ignoreDuplicates: true },
);

// Refuse duplicates on a plain insert: a sign-up with a taken email throws
// a CradlerError with status 409 and code "constraint_violation".
await cradler.from("users").insert({ email, passwordHash }, { unique: "email" });
```

The first `upsert` (or `insert` with `unique`) that names a field makes it
**unique in the collection for good**, so every later insert of a duplicate
gets a 409 too — even one that does not pass `unique`. Several fields
(`onConflict: ["userId", "platform"]`) are unique together. Rows with no
value for the field are not compared. `onConflict` defaults to `id`.

- If the collection already holds duplicates, that first call fails with a
  409 that says how many. Merge or delete them, then retry.
- Only the `service` key can make a field unique. The `anon` key can use a
  field that is already unique, and needs both insert and update permission
  to upsert.
- There is no self-serve way to make a field non-unique again yet, so name
  only fields that really must never repeat (emails, external ids,
  idempotency keys) — not names, titles or statuses.

### Counts, sums and averages

For any statistic — a total, an average, a count per category — use
`aggregate()`. It runs in the database over **every** matching row, so it
stays correct past the 1000 rows a single query can return:

```ts
// One row per status: how many orders, their revenue, the average order
const { rows } = await cradler
  .from("orders")
  .aggregate(
    { fn: "count" },
    { fn: "sum", field: "amount", as: "revenue" },
    { fn: "avg", field: "amount" },
  )
  .groupBy("status")
  .gte("createdAt", "2026-01-01")
  .order("revenue", { desc: true });
// [{ status: "paid", count: 1840, revenue: 51230.5, avgAmount: 27.84 }, ...]

// No groupBy() — a single row over everything that matches
const { rows: [stats] } = await cradler
  .from("orders")
  .aggregate({ fn: "max", field: "amount" })
  .eq("status", "paid");
```

Functions: `count` (no field = rows; with a field = rows where it is not
null), `sum` and `avg` (numeric fields), `min` and `max` (numbers, text,
dates). Each value comes back under its `as` key, or `count` / `sumAmount`
style by default. `.order()` takes a `groupBy` field or one of those keys;
`.limit()` / `.offset()` page through the groups (default 100, max 1000),
and `.count("exact")` returns `total`, the number of groups.

### Listing collections

```ts
const collections = await cradler.listCollections();
// [{ collection: "orders", columns: { id: "uuid", amount: "numeric", ... } }, ...]
```

With an `anon` key, only the collections that key is allowed to read are
listed.

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

A filter value of `undefined` throws (`invalid_filter`) — it almost always
means an unset variable. Use `isNull()` / `notNull()` to match missing values.

### Fields that have no value

A comparison never matches a row where the field is empty (`null`):
`.eq("used", false)` skips rows whose `used` was never set, and
`.neq("status", "done")` skips rows with no `status`. Use `isNull()` /
`notNull()` to match on emptiness.

A field nobody has written to the collection yet is empty on **every** row —
the column does not exist yet. So, on a field like that:

- `select()` / `aggregate()`: comparisons match nothing, `isNull()` matches
  every row, and selecting the field returns `null`.
- `update()` / `delete()`: comparisons match nothing, so **nothing is changed
  or deleted** — and the call still succeeds. `isNull()` is refused
  (`validation_failed`), since on a misspelt field it would hit every row.

Every such call comes back with a `warnings` entry naming the field, also
printed with `console.warn`. It is what a typo looks like, too.

**If your code will later filter on a field — a flag like `used`,
`revoked` or `processed` — write it explicitly on every insert**
(`insert({ ..., used: false })`). Otherwise
`update({ used: true }).eq("used", false)` changes nothing until some row
has set the field, and a "claim it once" check reads as "already claimed".

## Files and images

**Storage requires the `service` key, so call it from server-side code only**
(an API route, server action or backend job) — never from the browser. A
browser app sends the file to its own server route, which uploads it.

Files are **private by default** — read them through a short-lived signed URL.
Mark an upload **public** to store it in a CDN-backed bucket and get a stable
URL that loads fast worldwide, with optional on-the-fly resizing.

```ts
// Private upload (default) — body is a Blob/File, ArrayBuffer, typed array / Buffer, or string
await cradler.storage.upload("invoices/2026.pdf", file);

// A temporary signed URL to display or download a private file
const url = await cradler.storage.getUrl("invoices/2026.pdf");

// Public upload — stored on the CDN; returns a stable, cacheable URL
const { path, publicUrl } = await cradler.storage.upload("covers/dune.png", file, {
  public: true,
});

// A stable public URL, optionally resized at the edge (ideal for thumbnails).
// No round trip, no signature — drop it straight into an <img src>.
const thumb = await cradler.storage.getPublicUrl(path, { width: 300 });

// Download as a Blob, list (optionally by prefix), and delete
const blob = await cradler.storage.download("invoices/2026.pdf");
const files = await cradler.storage.list("covers/");
await cradler.storage.remove("covers/dune.png", { public: true });
```

`getPublicUrl` resizing (`width` / `height` / `quality`) is powered by
Cloudflare at the edge: the original is stored once, and each size is generated
and cached on demand — served as a modern format (WebP/AVIF) automatically. It
works only for files uploaded with `{ public: true }`.

### Image compression

Pass `{ compress: true }` to shrink and re-encode images before upload.
It needs browser canvas APIs (`createImageBitmap`), while storage needs the
`service` key, which must never be in a browser — so in practice, leave
`compress` off for now and upload from server code. Defaults: `webp`, max 2000×2000, quality
0.85 — typically 90%+ smaller than a raw phone photo. Non-image bodies
(PDFs, SVGs, zips, plain blobs) are passed through unchanged, so it's
safe to set on every upload.

When compression changes the format, the stored path's extension is
rewritten to match. Use the returned `path` when you save a reference:

```ts
const { path } = await cradler.storage.upload("avatars/cat.jpg", file, {
  compress: true,
});
// `path` is "avatars/cat.webp" — save *this* in the database.

// Tune it:
await cradler.storage.upload("photos/sunset.jpg", file, {
  compress: { maxWidth: 1600, quality: 0.9, format: "webp" },
});
```

Browser-only. In Node or edge runtimes, `compress: true` throws.

**For private files, save the path (`"invoices/2026.pdf"`), not the URL.**
URLs from `getUrl()` are short-lived signed URLs that expire; persisting them
leads to broken links. Resolve the path to a fresh URL with `getUrl()` whenever
you need to display it. (Public `publicUrl` / `getPublicUrl()` URLs are stable —
those are safe to store.)

## Errors

Any non-2xx response throws a `CradlerError` with `.status`, `.code`,
`.message`, `.details` and `.requestId` — for example `schema_conflict` when
a value clashes with a column's type. Quote `requestId` when reporting a
problem; it is in Cradler's server logs too.

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
