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
