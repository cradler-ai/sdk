/**
 * The SDK is the only surface users touch, and most of what it does is
 * translate between what a caller writes and what the gateway expects:
 * camelCase to snake_case, a chained builder to a JSON body, a body to a
 * declared upload size.
 *
 * These pin down that translation. `fetch` is stubbed, so no gateway is
 * needed — what is being tested is what goes out on the wire.
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createClient } from '../src/index'

type Captured = { url: string; init: RequestInit }

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function stub(replies: { status?: number; body: unknown }[]): Captured[] {
  const calls: Captured[] = []
  let i = 0
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    const reply = replies[Math.min(i++, replies.length - 1)]
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return calls
}

function db() {
  return createClient({
    url: 'https://gateway.example',
    projectId: 'proj',
    apiKey: 'k',
  })
}

const emptySet = { body: { rows: [], count: 0 } }

function bodyOf(call: Captured): Record<string, unknown> {
  return JSON.parse(String(call.init.body))
}

describe('update', () => {
  it('refuses to run without a filter', async () => {
    // The gateway rejects this too, as of the release that made filters
    // mandatory. Failing in the client says why, in one round trip fewer.
    const calls = stub([emptySet])
    await assert.rejects(
      () => db().from('users').update({ name: 'x' }),
      /at least one filter/,
    )
    assert.equal(calls.length, 0, 'nothing should have been sent')
  })

  it('sends the patch and filters when scoped', async () => {
    const calls = stub([emptySet])
    await db().from('users').update({ fullName: 'x' }).eq('userId', 7)
    const body = bodyOf(calls[0])
    // Keys are converted for the wire; the caller writes camelCase.
    assert.deepEqual(body.patch, { full_name: 'x' })
    assert.deepEqual(body.filters, [
      { field: 'user_id', op: 'eq', value: 7 },
    ])
  })
})

describe('delete', () => {
  it('refuses to run without a filter', async () => {
    const calls = stub([emptySet])
    await assert.rejects(
      () => db().from('users').delete(),
      /at least one filter/,
    )
    assert.equal(calls.length, 0)
  })
})

describe('select', () => {
  it('asks for a total only when count("exact") is chained', async () => {
    const plain = stub([emptySet])
    await db().from('users').select()
    assert.equal(bodyOf(plain[0]).count, undefined)

    const exact = stub([{ body: { rows: [], count: 0, total: 9 } }])
    const result = await db().from('users').select().count('exact')
    assert.equal(bodyOf(exact[0]).count, 'exact')
    assert.equal(result.total, 9)
  })

  it('omits total when the gateway did not send one', async () => {
    stub([emptySet])
    const result = await db().from('users').select()
    assert.equal('total' in result, false)
  })

  it('converts returned rows back to camelCase', async () => {
    stub([{ body: { rows: [{ user_id: 1, full_name: 'a' }], count: 1 } }])
    const result = await db().from('users').select()
    assert.deepEqual(result.rows[0], { userId: 1, fullName: 'a' })
  })
})

describe('upload', () => {
  it('declares the byte length of a string body', async () => {
    const calls = stub([
      { body: { path: 'a.txt', upload_url: 'https://bucket.example/put' } },
      { body: {} },
    ])
    // "héllo" is 6 bytes in UTF-8 but 5 characters — the signed
    // Content-Length has to match the bytes actually sent, not the length of
    // the string, or the bucket rejects the upload.
    await db().storage.upload('a.txt', 'héllo')
    assert.equal(bodyOf(calls[0]).size, 6)
  })

  it('declares the byte length of an ArrayBuffer body', async () => {
    const calls = stub([
      { body: { path: 'a.bin', upload_url: 'https://bucket.example/put' } },
      { body: {} },
    ])
    await db().storage.upload('a.bin', new ArrayBuffer(1234))
    assert.equal(bodyOf(calls[0]).size, 1234)
  })

  it('declares the byte length of a Blob body', async () => {
    const calls = stub([
      { body: { path: 'a.bin', upload_url: 'https://bucket.example/put' } },
      { body: {} },
    ])
    await db().storage.upload('a.bin', new Blob([new Uint8Array(77)]))
    assert.equal(bodyOf(calls[0]).size, 77)
  })
})

describe('errors', () => {
  it('carries the gateway code and message', async () => {
    stub([
      {
        status: 402,
        body: {
          error: {
            code: 'quota_exceeded',
            message: 'out of requests',
            request_id: 'r1',
          },
        },
      },
    ])
    const err = await db()
      .from('users')
      .select()
      .then(() => null)
      .catch((e) => e as { code?: string; status?: number })
    assert.equal(err?.code, 'quota_exceeded')
    assert.equal(err?.status, 402)
  })
})

describe('fetch binding', () => {
  // Workers and browsers reject `fetch` called with any `this` but the
  // global scope ("Illegal invocation"). Node doesn't care, so emulate it.
  function strictFetch(reply: unknown): typeof fetch {
    return function (this: unknown) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError('Illegal invocation')
      }
      return Promise.resolve(Response.json(reply))
    } as unknown as typeof fetch
  }

  it('calls the global fetch without rebinding `this`', async () => {
    globalThis.fetch = strictFetch(emptySet.body)
    await db().from('users').select()
  })

  it('calls a caller-supplied unbound fetch without rebinding `this`', async () => {
    const client = createClient({
      url: 'https://gateway.example',
      projectId: 'proj',
      apiKey: 'k',
      fetch: strictFetch(emptySet.body),
    })
    await client.from('users').select()
  })
})

describe('filter values', () => {
  // JSON drops `undefined` and the gateway reads a missing value as null, so
  // an unset variable used to turn `.neq('status', x)` into `IS NOT NULL` —
  // on delete(), that removes every row with any status at all.
  it('refuses an undefined filter value before anything is sent', async () => {
    const calls = stub([emptySet])
    const unset: string | undefined = undefined
    await assert.rejects(
      async () => db().from('posts').delete().neq('status', unset),
      (e: { code?: string }) => e.code === 'invalid_filter',
    )
    await assert.rejects(
      async () => db().from('posts').update({ a: 1 }).eq('ownerId', unset),
      (e: { code?: string }) => e.code === 'invalid_filter',
    )
    assert.equal(calls.length, 0, 'nothing should have been sent')
  })

  it('still sends an explicit null', async () => {
    const calls = stub([emptySet])
    await db().from('posts').select().eq('ownerId', null)
    assert.deepEqual(bodyOf(calls[0]).filters, [
      { field: 'owner_id', op: 'eq', value: null },
    ])
  })
})

describe('upload bodies', () => {
  it('sizes a Blob from another realm or a polyfill', async () => {
    // jsdom / happy-dom / fetch-blob Blobs are not `instanceof` this realm's
    // Blob. They used to fall through to `.byteLength` (undefined), so no
    // size was declared and no content type was sent.
    const calls = stub([
      { body: { path: 'a.txt', upload_url: 'https://bucket.example/put' } },
      { body: {} },
    ])
    const foreign = {
      size: 5,
      type: 'text/plain',
      arrayBuffer: async () => new ArrayBuffer(5),
      stream: () => new Blob(['hello']).stream(),
      text: async () => 'hello',
      slice: () => new Blob(['hello']),
    }
    await db().storage.upload('a.txt', foreign as unknown as Blob)
    assert.equal(bodyOf(calls[0]).size, 5)
    const headers = calls[1].init.headers as Record<string, string>
    assert.equal(headers['content-type'], 'text/plain')
  })

  it('sizes a typed array / Buffer view by its own bytes', async () => {
    const calls = stub([
      { body: { path: 'a.bin', upload_url: 'https://bucket.example/put' } },
      { body: {} },
    ])
    const view = new Uint8Array(new ArrayBuffer(100), 10, 20)
    await db().storage.upload('a.bin', view)
    assert.equal(bodyOf(calls[0]).size, 20)
  })

  it('rejects a body with no known length before asking for a URL', async () => {
    const calls = stub([
      { body: { path: 'a.bin', upload_url: 'https://bucket.example/put' } },
    ])
    await assert.rejects(
      () =>
        db().storage.upload(
          'a.bin',
          new Blob(['x']).stream() as unknown as ArrayBuffer,
        ),
      (e: { code?: string }) => e.code === 'invalid_body',
    )
    assert.equal(calls.length, 0)
  })
})

describe('getPublicUrl', () => {
  function publicStub() {
    return stub([
      {
        body: {
          public_enabled: true,
          public_url: 'https://files.example/proj',
        },
      },
    ])
  }

  it('encodes the path the same way the gateway does', async () => {
    // The gateway builds `publicUrl` with Python's quote(key, safe="/").
    // A raw `#` used to turn the rest of the name into a URL fragment.
    publicStub()
    const url = await db().storage.getPublicUrl("photos/my cat #1 (it's).png")
    assert.equal(
      url,
      'https://files.example/proj/photos/my%20cat%20%231%20%28it%27s%29.png',
    )
  })

  it('encodes the path in a transformed URL too', async () => {
    publicStub()
    const url = await db().storage.getPublicUrl('/a?b.png', { width: 300 })
    assert.equal(
      url,
      'https://files.example/cdn-cgi/image/width=300,format=auto/proj/a%3Fb.png',
    )
  })
})

describe('error request id', () => {
  it('exposes the gateway request id as requestId', async () => {
    stub([
      {
        status: 422,
        body: {
          error: {
            code: 'validation_failed',
            message: 'bad',
            request_id: 'abc123',
          },
        },
      },
    ])
    const err = await db()
      .from('users')
      .select()
      .then(() => null)
      .catch((e) => e as { requestId?: string })
    assert.equal(err?.requestId, 'abc123')
  })
})

describe('Supabase-style habits', () => {
  // Seen in production 422s: select('amount,reason,ts'), select('*'),
  // from('lifeItems'). AI tools write these from Supabase muscle memory.
  it("select('*') selects every column", async () => {
    const calls = stub([emptySet])
    await db().from('t').select('*')
    assert.equal(bodyOf(calls[0]).select, undefined)
  })

  it('select splits a comma-separated column string', async () => {
    const calls = stub([emptySet])
    await db().from('t').select('amount, reason,createdAt')
    assert.deepEqual(bodyOf(calls[0]).select, ['amount', 'reason', 'created_at'])
  })

  it('from() snake_cases a camelCase collection name', async () => {
    const calls = stub([emptySet])
    await db().from('lifeItems').select()
    assert.match(calls[0].url, /\/life_items\/query$/)
  })
})

describe('non-finite numbers', () => {
  // JSON.stringify(NaN) === 'null': a NaN used to be stored as null, silently.
  it('insert refuses NaN / Infinity, nested too, and sends nothing', async () => {
    const calls = stub([emptySet])
    await assert.rejects(() => db().from('t').insert({ avg: 0 / 0 }), /NaN/)
    await assert.rejects(
      () => db().from('t').insert([{ a: 1 }, { meta: { score: Infinity } }]),
      /row 1 field 'meta'\.score is Infinity/,
    )
    assert.equal(calls.length, 0)
  })

  it('update and filters refuse them as well', async () => {
    const calls = stub([emptySet])
    await assert.rejects(
      () => db().from('t').update({ ratio: -Infinity }).eq('id', 'x'),
      /-Infinity/,
    )
    assert.throws(() => db().from('t').select().gt('score', NaN), /NaN/)
    assert.equal(calls.length, 0)
  })
})

describe('aggregate', () => {
  it('sends group_by, aggregates, filters and order in snake_case', async () => {
    const calls = stub([emptySet])
    await db()
      .from('orders')
      .aggregate(
        { fn: 'count' },
        { fn: 'sum', field: 'totalAmount', as: 'revenue' },
        { fn: 'avg', field: 'totalAmount' },
      )
      .groupBy('shopId')
      .eq('isPaid', true)
      .order('avgTotalAmount', { desc: true })
      .limit(20)
      .count('exact')
    assert.match(calls[0].url, /\/v1\/proj\/orders\/aggregate$/)
    assert.deepEqual(bodyOf(calls[0]), {
      group_by: ['shop_id'],
      aggregates: [
        { fn: 'count' },
        { fn: 'sum', field: 'total_amount', as: 'revenue' },
        { fn: 'avg', field: 'total_amount' },
      ],
      filters: [{ field: 'is_paid', op: 'eq', value: true }],
      order: [{ field: 'avg_total_amount', desc: true }],
      limit: 20,
      count: 'exact',
    })
  })

  it('returns group fields and default keys in camelCase', async () => {
    stub([{
      body: {
        rows: [{ shop_id: 's1', sum_total_amount: 12.5 }],
        count: 1,
        total: 3,
      },
    }])
    const res = await db()
      .from('orders')
      .aggregate({ fn: 'sum', field: 'totalAmount' })
      .groupBy('shopId')
    assert.deepEqual(res.rows, [{ shopId: 's1', sumTotalAmount: 12.5 }])
    assert.equal(res.total, 3)
  })
})

describe('listCollections', () => {
  it('lists collections with camelCase column names', async () => {
    const calls = stub([{
      body: {
        collections: [
          { collection: 'life_items', columns: { id: 'uuid', due_at: 'timestamp with time zone' } },
        ],
      },
    }])
    const found = await db().listCollections()
    assert.equal(calls[0].init.method, 'GET')
    assert.match(calls[0].url, /\/v1\/proj\/collections$/)
    assert.deepEqual(found, [
      { collection: 'life_items', columns: { id: 'uuid', dueAt: 'timestamp with time zone' } },
    ])
  })
})

describe('warnings', () => {
  it('surfaces gateway warnings on the result and on console.warn', async () => {
    const warning =
      "field 'used' has not been written to 'tokens' yet; treated as null on every row"
    stub([{ body: { rows: [], count: 0, warnings: [warning] } }])
    const printed: unknown[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => { printed.push(args.join(' ')) }
    try {
      const res = await db().from('tokens').update({ used: true }).eq('used', false)
      assert.deepEqual(res.warnings, [warning])
      assert.deepEqual(printed, [`[cradler] ${warning}`])
    } finally {
      console.warn = realWarn
    }
  })

  it('leaves warnings off a result that has none', async () => {
    stub([emptySet])
    const res = await db().from('tokens').select()
    assert.equal('warnings' in res, false)
  })
})

describe('upsert', () => {
  it('sends rows and the conflict fields in snake_case', async () => {
    const calls = stub([emptySet])
    await db().from('users').upsert(
      { emailAddress: 'a@x.io', fullName: 'A' },
      { onConflict: 'emailAddress' },
    )
    assert.match(calls[0].url, /\/v1\/proj\/users\/upsert$/)
    assert.deepEqual(bodyOf(calls[0]), {
      rows: [{ email_address: 'a@x.io', full_name: 'A' }],
      on_conflict: ['email_address'],
    })
  })

  it("accepts Supabase's comma-separated onConflict and ignoreDuplicates", async () => {
    const calls = stub([emptySet])
    await db().from('targets').upsert([{ userId: 'u', platform: 'x' }], {
      onConflict: 'userId, platform' as 'userId',
      ignoreDuplicates: true,
    })
    assert.deepEqual(bodyOf(calls[0]).on_conflict, ['user_id', 'platform'])
    assert.equal(bodyOf(calls[0]).ignore_duplicates, true)
  })

  it('leaves the conflict fields to the gateway default (id) when omitted', async () => {
    const calls = stub([emptySet])
    await db().from('posts').upsert({ id: 'x', title: 't' })
    assert.equal('on_conflict' in bodyOf(calls[0]), false)
  })

  it('refuses NaN before anything is sent', async () => {
    const calls = stub([emptySet])
    await assert.rejects(() => db().from('posts').upsert({ id: 'x', score: NaN }))
    assert.equal(calls.length, 0)
  })
})

describe('insert unique', () => {
  it('passes the unique fields as a query parameter', async () => {
    const calls = stub([emptySet])
    await db().from('users').insert({ emailAddress: 'a' }, { unique: ['emailAddress', 'tenantId'] })
    assert.match(calls[0].url, /\/v1\/proj\/users\?unique=email_address%2Ctenant_id$/)
    assert.deepEqual(bodyOf(calls[0]), [{ email_address: 'a' }])
  })

  it('sends a plain insert when unique is not given', async () => {
    const calls = stub([emptySet])
    await db().from('users').insert({ a: 1 })
    assert.match(calls[0].url, /\/v1\/proj\/users$/)
  })
})
