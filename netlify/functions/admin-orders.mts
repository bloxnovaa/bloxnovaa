// Password-protected admin dashboard endpoints (header: x-admin-password):
//   GET    /api/admin/orders           -> all orders, newest first
//   PATCH  /api/admin/orders           -> { invoice, status } or { invoices: [...], status } (bulk approve / reject)
//   DELETE /api/admin/orders           -> clears all orders and their proofs
//   GET    /api/admin/proof?invoice=…  -> the uploaded proof image
import type { Config, Context } from '@netlify/functions'
import { getDatabase } from '@netlify/database'
import { INVOICE_RE, STATUSES, isAdmin, json, proofStore } from '../lib/orders.mts'
import { notifyBuyers } from '../lib/push.mts'

const db = getDatabase()

async function listOrders() {
  const rows = await db.sql`
    SELECT o.invoice, o.username, o.package, o.account_type, o.total, o.language, o.status, o.sender_name,
           o.proof_key IS NOT NULL AS has_proof, o.created_at, o.proof_at, o.listing_id, o.contact,
           (l.account_username <> '' AND l.login_password <> '') AS has_login
    FROM orders o LEFT JOIN account_listings l ON l.id = o.listing_id
    ORDER BY COALESCE(o.proof_at, o.created_at) DESC
    LIMIT 500
  `
  return json({
    orders: rows.map((r) => ({
      invoice: r.invoice,
      username: r.username,
      package: r.package,
      accountType: r.account_type,
      total: r.total,
      language: r.language,
      status: r.status,
      senderName: r.sender_name,
      hasProof: r.has_proof,
      createdAt: r.created_at,
      proofAt: r.proof_at,
      listingId: r.listing_id,
      contact: r.contact,
      hasLogin: Boolean(r.has_login),
    })),
  })
}

async function updateStatus(req: Request, context: Context) {
  const body = await req.json().catch(() => ({}))
  const invoices: unknown[] = Array.isArray(body.invoices) ? body.invoices : [body.invoice]
  const { status } = body
  if (!invoices.length || invoices.length > 500 || !invoices.every((i) => typeof i === 'string' && INVOICE_RE.test(i)) || !STATUSES.includes(status)) {
    return json({ error: 'invalid_request' }, 400)
  }
  // An account can only be handed over when its login details are filled in.
  if (status === 'done') {
    const missing = await db.sql`
      SELECT o.invoice FROM orders o JOIN account_listings l ON l.id = o.listing_id
      WHERE o.invoice = ANY(${invoices}) AND (l.account_username = '' OR l.login_password = '')
    `
    if (missing.length) return json({ error: 'missing_login', invoices: missing.map((r) => r.invoice) }, 409)
  }
  // Orders already in the target status are skipped so buyers are not notified twice.
  const rows = await db.sql`
    UPDATE orders SET status = ${status}
    WHERE invoice = ANY(${invoices}) AND status <> ${status}
    RETURNING invoice, username, package, total, language, status, listing_id
  `
  // Approved account orders mark the account as sold; rejected ones put it back on sale.
  const sold = rows.filter((r) => r.listing_id && r.status === 'done')
  const released = rows.filter((r) => r.listing_id && r.status !== 'done')
  if (sold.length) {
    await db.sql`
      UPDATE account_listings SET status = 'sold', sold_at = COALESCE(sold_at, NOW())
      WHERE id = ANY(${sold.map((r) => r.listing_id)})
    `
  }
  if (released.length) {
    await db.sql`
      UPDATE account_listings SET reserved_invoice = NULL, reserved_until = NULL
      WHERE reserved_invoice = ANY(${released.map((r) => r.invoice)}) AND status = 'available'
    `
  }
  if (rows.length) context.waitUntil(notifyBuyers(rows as any))
  if (!rows.length && !Array.isArray(body.invoices)) {
    const [exists] = await db.sql`SELECT 1 FROM orders WHERE invoice = ${invoices[0]}`
    if (!exists) return json({ error: 'not_found' }, 404)
  }
  return json({ ok: true, updated: rows.map((r) => r.invoice) })
}

async function clearOrders() {
  const store = proofStore()
  const rows = await db.sql`DELETE FROM orders RETURNING proof_key`
  await db.sql`DELETE FROM push_subscriptions WHERE role = 'buyer'`
  await Promise.all(rows.filter((r) => r.proof_key).map((r) => store.delete(r.proof_key)))
  return json({ ok: true, deleted: rows.length })
}

async function getProof(req: Request) {
  const invoice = new URL(req.url).searchParams.get('invoice') || ''
  if (!INVOICE_RE.test(invoice)) return json({ error: 'invalid_invoice' }, 400)
  const [row] = await db.sql`SELECT proof_key, proof_type FROM orders WHERE invoice = ${invoice}`
  if (!row?.proof_key) return json({ error: 'not_found' }, 404)
  const data = await proofStore().get(row.proof_key, { type: 'arrayBuffer' })
  if (!data) return json({ error: 'not_found' }, 404)
  return new Response(data, {
    headers: { 'content-type': row.proof_type || 'image/jpeg', 'cache-control': 'private, no-store' },
  })
}

export default async (req: Request, context: Context) => {
  if (!isAdmin(req)) return json({ error: 'unauthorized' }, 401)
  const { pathname } = new URL(req.url)
  try {
    if (pathname === '/api/admin/proof' && req.method === 'GET') return await getProof(req)
    if (pathname === '/api/admin/orders') {
      if (req.method === 'GET') return await listOrders()
      if (req.method === 'PATCH') return await updateStatus(req, context)
      if (req.method === 'DELETE') return await clearOrders()
    }
    return json({ error: 'not_found' }, 404)
  } catch (err) {
    console.error('admin endpoint failed', err)
    return json({ error: 'server_error' }, 500)
  }
}

export const config: Config = {
  path: ['/api/admin/orders', '/api/admin/proof'],
}
