// Public order endpoints used by the storefront:
//   POST /api/orders         -> records a new order when the buyer opens checkout
//   POST /api/orders/proof   -> uploads the payment proof (multipart form)
//   GET  /api/orders/track   -> order status lookup by invoice or username
//   GET  /api/orders/recent  -> latest completed orders (masked usernames) for the live feed
//   GET  /api/orders/login   -> login details of a bought account, once the admin approved the invoice
import { createHash, randomUUID } from 'node:crypto'
import type { Config, Context } from '@netlify/functions'
import { getDatabase } from '@netlify/database'
import { INVOICE_RE, json, parseOrder, proofStore } from '../lib/orders.mts'
import { formatRupiah, notifyAdmins } from '../lib/push.mts'
import { listingPackage, reserveListing } from '../lib/accounts.mts'

const MAX_PROOF_BYTES = 4 * 1024 * 1024
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']

const db = getDatabase()

type Order = NonNullable<ReturnType<typeof parseOrder>>

// Account orders must hold the listing at its real price; the package label comes from the server.
async function claimListing(order: Order, hours: number) {
  if (!order.listingId) return true
  if (!order.contact) return false
  const listing = await reserveListing(order.listingId, order.invoice, order.total, hours)
  if (!listing) return false
  order.package = listingPackage(listing)
  return true
}

const contactNote = (order: Order) => (order.contact ? ` • kontak ${order.contact}` : '')

async function createOrder(req: Request, context: Context) {
  const order = parseOrder(await req.json().catch(() => ({})))
  if (!order) return json({ error: 'invalid_order' }, 400)
  if (!(await claimListing(order, 1))) return json({ error: 'listing_unavailable' }, 409)

  const inserted = await db.sql`
    INSERT INTO orders (invoice, username, package, account_type, total, language, listing_id, contact)
    VALUES (${order.invoice}, ${order.username}, ${order.package}, ${order.accountType}, ${order.total}, ${order.language},
            ${order.listingId}, ${order.contact || null})
    ON CONFLICT (invoice) DO NOTHING
    RETURNING invoice
  `
  if (inserted.length) {
    context.waitUntil(
      notifyAdmins({
        title: '🛒 Pesanan baru masuk',
        body: `@${order.username} • ${order.package} • ${formatRupiah(order.total)}${contactNote(order)} — menunggu bukti`,
        tag: `admin-${order.invoice}`,
      }),
    )
  }
  return json({ ok: true, invoice: order.invoice }, 201)
}

async function submitProof(req: Request, context: Context) {
  const form = await req.formData().catch(() => null)
  if (!form) return json({ error: 'invalid_form' }, 400)

  const order = parseOrder(Object.fromEntries(form))
  if (!order) return json({ error: 'invalid_order' }, 400)

  const file = form.get('proof')
  if (!(file instanceof File) || file.size === 0) return json({ error: 'missing_proof' }, 400)
  if (file.size > MAX_PROOF_BYTES) return json({ error: 'proof_too_large' }, 413)
  if (!IMAGE_TYPES.includes(file.type)) return json({ error: 'invalid_proof_type' }, 415)

  const senderName = String(form.get('senderName') || '').trim().slice(0, 80)

  const [existing] = await db.sql`SELECT proof_key FROM orders WHERE invoice = ${order.invoice}`
  if (existing?.proof_key) return json({ error: 'proof_already_sent' }, 409)
  const store = proofStore()
  const bytes = await file.arrayBuffer()
  const hash = createHash('sha256').update(new Uint8Array(bytes)).digest('hex')

  // Index older uploads before accepting new proofs. Keep fingerprints even when
  // the admin clears order history, so clearing history cannot enable reuse.
  const legacy = await db.sql`
    SELECT o.proof_key FROM orders o
    WHERE o.proof_key IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM payment_proof_fingerprints p WHERE p.proof_key = o.proof_key)
  `
  for (const row of legacy) {
    const previous = await store.get(row.proof_key, { type: 'arrayBuffer' })
    if (!previous) continue
    const previousHash = createHash('sha256').update(new Uint8Array(previous)).digest('hex')
    await db.sql`
      INSERT INTO payment_proof_fingerprints (hash, proof_key)
      VALUES (${previousHash}, ${row.proof_key}) ON CONFLICT DO NOTHING
    `
  }
  const [duplicate] = await db.sql`SELECT hash FROM payment_proof_fingerprints WHERE hash = ${hash}`
  if (duplicate) return json({ error: 'proof_reused' }, 409)

  // A paid account stays held for the buyer until the admin approves or rejects the proof.
  if (!(await claimListing(order, 24 * 7))) return json({ error: 'listing_unavailable' }, 409)

  const proofKey = `${order.invoice}-${randomUUID()}`

  // The unique fingerprint and order update commit together, including when
  // two invoices attempt to submit the same file at the same time.
  let accepted = false
  const client = await db.pool.connect()
  try {
    await store.set(proofKey, bytes)
    await client.query('BEGIN')
    const claimed = await client.query(
      `INSERT INTO payment_proof_fingerprints (hash, proof_key) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING hash`, [hash, proofKey],
    )
    if (!claimed.rows.length) {
      await client.query('ROLLBACK')
      return json({ error: 'proof_reused' }, 409)
    }
    const updated = await client.query(`
      INSERT INTO orders (invoice, username, package, account_type, total, language, status, sender_name, proof_key, proof_type, proof_at,
                          listing_id, contact)
      VALUES ($1, $2, $3, $4, $5, $6, 'proof_sent', $7, $8, $9, NOW(), $10, $11)
      ON CONFLICT (invoice) DO UPDATE SET
        status = 'proof_sent', sender_name = EXCLUDED.sender_name, proof_key = EXCLUDED.proof_key,
        proof_type = EXCLUDED.proof_type, proof_at = NOW()
      WHERE orders.proof_key IS NULL
      RETURNING invoice
    `, [order.invoice, order.username, order.package, order.accountType, order.total, order.language,
        senderName, proofKey, file.type, order.listingId, order.contact || null])
    if (!updated.rows.length) {
      await client.query('ROLLBACK')
      return json({ error: 'proof_already_sent' }, 409)
    }
    await client.query('COMMIT')
    accepted = true
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
    if (!accepted) await store.delete(proofKey)
  }
  context.waitUntil(
    notifyAdmins({
      title: '💸 Bukti pembayaran masuk!',
      body: `@${order.username} • ${order.package} • ${formatRupiah(order.total)}${senderName ? ` • a.n ${senderName}` : ''}${contactNote(order)} — siap dicek`,
      tag: `admin-${order.invoice}`,
    }),
  )
  return json({ ok: true, invoice: order.invoice }, 201)
}

async function trackOrder(req: Request) {
  const q = (new URL(req.url).searchParams.get('q') || '').trim().replace(/^@/, '').slice(0, 30)
  if (!q) return json({ error: 'missing_query' }, 400)

  // Account purchases can only be looked up by invoice (their username is a placeholder like Akun_12).
  const [row] = await db.sql`
    SELECT invoice, username, package, total, status, sender_name, created_at, proof_at, listing_id
    FROM orders
    WHERE invoice = ${q.toUpperCase()} OR (LOWER(username) = ${q.toLowerCase()} AND listing_id IS NULL)
    ORDER BY created_at DESC
    LIMIT 1
  `
  if (!row) return json({ error: 'not_found' }, 404)
  return json({
    invoice: row.invoice,
    username: row.username,
    package: row.package,
    total: row.total,
    status: row.status,
    senderName: row.sender_name,
    createdAt: row.created_at,
    proofAt: row.proof_at,
    isAccount: Boolean(row.listing_id),
  })
}

// The invoice number acts as the buyer's key: it is random and only known to the buyer's device.
async function accountLogin(req: Request) {
  const invoice = (new URL(req.url).searchParams.get('invoice') || '').toUpperCase()
  if (!INVOICE_RE.test(invoice)) return json({ error: 'invalid_invoice' }, 400)
  const [row] = await db.sql`
    SELECT o.status, l.id, l.title, l.game_name, l.account_username, l.login_password, l.login_note
    FROM orders o JOIN account_listings l ON l.id = o.listing_id
    WHERE o.invoice = ${invoice}
  `
  if (!row) return json({ error: 'not_found' }, 404)
  if (row.status !== 'done') return json({ error: 'not_approved', status: row.status }, 403)
  return json({
    id: row.id,
    title: row.title,
    game: row.game_name,
    username: row.account_username,
    password: row.login_password,
    note: row.login_note,
  })
}

const maskName = (name: string) => (name.length <= 3 ? `${name[0]}**` : `${name.slice(0, 2)}${'*'.repeat(Math.min(name.length - 3, 4))}${name.slice(-1)}`)

async function recentOrders() {
  const rows = await db.sql`
    SELECT username, package, COALESCE(proof_at, created_at) AS at
    FROM orders WHERE status = 'done'
    ORDER BY COALESCE(proof_at, created_at) DESC
    LIMIT 12
  `
  const [stats] = await db.sql`
    SELECT COUNT(*)::int AS done, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS today
    FROM orders WHERE status = 'done'
  `
  return new Response(
    JSON.stringify({
      orders: rows.map((r) => ({ user: maskName(r.username), package: r.package, at: r.at })),
      stats: { done: stats?.done || 0, today: stats?.today || 0 },
    }),
    { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' } },
  )
}

export default async (req: Request, context: Context) => {
  const { pathname } = new URL(req.url)
  try {
    if (req.method === 'POST' && pathname === '/api/orders') return await createOrder(req, context)
    if (req.method === 'POST' && pathname === '/api/orders/proof') return await submitProof(req, context)
    if (req.method === 'GET' && pathname === '/api/orders/track') return await trackOrder(req)
    if (req.method === 'GET' && pathname === '/api/orders/recent') return await recentOrders()
    if (req.method === 'GET' && pathname === '/api/orders/login') return await accountLogin(req)
    return json({ error: 'not_found' }, 404)
  } catch (err) {
    console.error('orders endpoint failed', err)
    return json({ error: 'server_error' }, 500)
  }
}

export const config: Config = {
  path: ['/api/orders', '/api/orders/proof', '/api/orders/track', '/api/orders/recent', '/api/orders/login'],
}
