/**
 * camelCase <-> snake_case key conversion.
 *
 * The gateway uses snake_case identifiers (clean Postgres columns); JS/TS code
 * (and AI-generated code) uses camelCase. The SDK converts transparently:
 * callers write camelCase, the database stays snake_case.
 *
 * Only top-level keys (= column names) are converted. Nested values — e.g. the
 * contents of a JSONB column — are user data and are left untouched.
 */

export function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c, i) => (i === 0 ? '' : '_') + c.toLowerCase())
}

export function toCamel(key: string): string {
  const lead = key.match(/^_+/)?.[0] ?? ''
  const parts = key.slice(lead.length).split('_')
  return (
    lead +
    parts
      .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
      .join('')
  )
}

export function snakeKeys(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) out[toSnake(k)] = v
  return out
}

export function camelKeys<T>(obj: Record<string, unknown>): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) out[toCamel(k)] = v
  return out as T
}
