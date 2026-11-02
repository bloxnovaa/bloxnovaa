import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import { createHash, randomUUID } from 'node:crypto'

const source = stripTypeScriptTypes(readFileSync(new URL('../netlify/functions/orders.mts', import.meta.url), 'utf8'))
  .replace(/^import .*$/gm, '')
  .replace('export default async', 'globalThis.handler = async')
  .replace('export const config', 'const config')

function setup({ duplicate = false, existing = false, race = false, legacy = false, fail = false } = {}) {
  const blobs = new Map(legacy ? [['old-proof', new TextEncoder().encode('same-photo').buffer]] : [])
  const fingerprints = new Set(duplicate ? [createHash('sha256').update('same-photo').digest('hex')] : [])
  const statements = []
  let pending
  const client = {
    async query(sql, values) {
      statements.push(sql)
      if (sql === 'ROLLBACK') pending = undefined
      if (sql === 'COMMIT') fingerprints.add(pending)
      if (sql.includes('INSERT INTO payment_proof_fingerprints')) {
        if (race || fingerprints.has(values[0])) return { rows: [] }
        pending = values[0]
        return { rows: [{ hash: pending }] }
      }
      if (sql.includes('INSERT INTO orders')) {
        if (fail) throw new Error('database unavailable')
        return { rows: existing === 'race' ? [] : [{ invoice: values[0] }] }
      }
      return { rows: [] }
    },
    release() {},
  }
  const db = {
    async sql(parts, ...values) {
      const sql = parts.join('?')
      if (sql.includes('SELECT proof_key FROM orders')) return existing === true ? [{ proof_key: 'existing' }] : []
      if (sql.includes('SELECT o.proof_key')) return legacy ? [{ proof_key: 'old-proof' }] : []
      if (sql.includes('INSERT INTO payment_proof_fingerprints')) { fingerprints.add(values[0]); return [] }
      if (sql.includes('SELECT hash FROM')) return fingerprints.has(values[0]) ? [{ hash: values[0] }] : []
      throw new Error('Unexpected query')
    },
    pool: { async connect() { return client } },
  }
  const sandbox = {
    createHash, randomUUID, getDatabase: () => db,
    proofStore: () => ({ get: async key => blobs.get(key), set: async (key, bytes) => blobs.set(key, bytes), delete: async key => blobs.delete(key) }),
    parseOrder: value => value, json: (value, status = 200) => Response.json(value, { status }),
    notifyAdmins: async () => {}, formatRupiah: String, reserveListing: async () => true,
    URL, File, Response, console: { error() {} },
  }
  runInNewContext(source, sandbox)
  return {
    blobs, fingerprints, statements,
    async send(contents = 'same-photo') {
      const form = new FormData()
      form.set('invoice', 'BNX-ABCDEF123456')
      form.set('username', 'buyer')
      form.set('proof', new File([contents], 'renamed.png', { type: 'image/png' }))
      return sandbox.handler(new Request('https://example.com/api/orders/proof', { method: 'POST', body: form }), { waitUntil() {} })
    },
  }
}

test('new proof commits its fingerprint and image', async () => {
  const app = setup()
  assert.equal((await app.send()).status, 201)
  assert.equal(app.blobs.size, 1)
  assert.equal(app.fingerprints.size, 1)
})
test('same file is rejected even with another filename and cleared order history', async () => {
  const app = setup({ duplicate: true })
  const response = await app.send()
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error, 'proof_reused')
  assert.equal(app.blobs.size, 0)
})
test('historical proofs are indexed and rejected', async () => {
  const app = setup({ legacy: true })
  assert.equal((await (await app.send()).json()).error, 'proof_reused')
  assert.equal(app.blobs.size, 1)
})
test('simultaneous duplicate loses fingerprint claim and removes unused image', async () => {
  const app = setup({ race: true })
  assert.equal((await (await app.send()).json()).error, 'proof_reused')
  assert.equal(app.blobs.size, 0)
  assert.ok(app.statements.includes('ROLLBACK'))
})
test('invoice already containing proof rejects resubmission', async () => {
  const app = setup({ existing: true })
  assert.equal((await (await app.send()).json()).error, 'proof_already_sent')
  assert.equal(app.blobs.size, 0)
})
test('invoice race rolls back fingerprint and removes unused image', async () => {
  const app = setup({ existing: 'race' })
  assert.equal((await (await app.send()).json()).error, 'proof_already_sent')
  assert.equal(app.fingerprints.size, 0)
  assert.equal(app.blobs.size, 0)
})
test('database failure rolls back fingerprint and removes unused image', async () => {
  const app = setup({ fail: true })
  assert.equal((await app.send()).status, 500)
  assert.equal(app.fingerprints.size, 0)
  assert.equal(app.blobs.size, 0)
})
