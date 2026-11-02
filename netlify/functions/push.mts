// Web Push subscription endpoints:
//   GET  /api/push/key          -> VAPID public key for PushManager.subscribe
//   POST /api/push/subscribe    -> { subscription, invoice } (buyer) or { subscription, role: 'admin' } + x-admin-password
//   POST /api/push/unsubscribe  -> { endpoint, role? } removes the device
import type { Config } from '@netlify/functions'
import { getDatabase } from '@netlify/database'
import { INVOICE_RE, isAdmin, json } from '../lib/orders.mts'
import { getVapid } from '../lib/push.mts'

const db = getDatabase()

function parseSubscription(input: any) {
  const endpoint = String(input?.endpoint || '')
  const p256dh = String(input?.keys?.p256dh || '')
  const auth = String(input?.keys?.auth || '')
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) return null
  return { endpoint, p256dh, auth }
}

async function subscribe(req: Request) {
  const body = await req.json().catch(() => ({}))
  const sub = parseSubscription(body.subscription)
  if (!sub) return json({ error: 'invalid_subscription' }, 400)

  if (body.role === 'admin') {
    if (!isAdmin(req)) return json({ error: 'unauthorized' }, 401)
    await db.sql`
      INSERT INTO push_subscriptions (endpoint, p256dh, auth, role, invoice)
      VALUES (${sub.endpoint}, ${sub.p256dh}, ${sub.auth}, 'admin', '')
      ON CONFLICT (endpoint, role, invoice) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
    `
    return json({ ok: true, role: 'admin' }, 201)
  }

  const invoice = String(body.invoice || '').toUpperCase()
  if (!INVOICE_RE.test(invoice)) return json({ error: 'invalid_invoice' }, 400)
  // Only invoices that exist can be followed, and each device keeps a handful at most.
  const [order] = await db.sql`SELECT 1 FROM orders WHERE invoice = ${invoice}`
  if (!order) return json({ error: 'not_found' }, 404)
  await db.sql`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, role, invoice)
    VALUES (${sub.endpoint}, ${sub.p256dh}, ${sub.auth}, 'buyer', ${invoice})
    ON CONFLICT (endpoint, role, invoice) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
  `
  await db.sql`
    DELETE FROM push_subscriptions WHERE endpoint = ${sub.endpoint} AND role = 'buyer' AND id NOT IN (
      SELECT id FROM push_subscriptions WHERE endpoint = ${sub.endpoint} AND role = 'buyer' ORDER BY created_at DESC LIMIT 10
    )
  `
  return json({ ok: true, role: 'buyer', invoice }, 201)
}

async function unsubscribe(req: Request) {
  const body = await req.json().catch(() => ({}))
  const endpoint = String(body.endpoint || '')
  if (!endpoint) return json({ error: 'invalid_request' }, 400)
  if (body.role === 'admin') await db.sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint} AND role = 'admin'`
  else await db.sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`
  return json({ ok: true })
}

export default async (req: Request) => {
  const { pathname } = new URL(req.url)
  try {
    if (req.method === 'GET' && pathname === '/api/push/key') return json({ publicKey: (await getVapid()).publicKey })
    if (req.method === 'POST' && pathname === '/api/push/subscribe') return await subscribe(req)
    if (req.method === 'POST' && pathname === '/api/push/unsubscribe') return await unsubscribe(req)
    return json({ error: 'not_found' }, 404)
  } catch (err) {
    console.error('push endpoint failed', err)
    return json({ error: 'server_error' }, 500)
  }
}

export const config: Config = {
  path: ['/api/push/key', '/api/push/subscribe', '/api/push/unsubscribe'],
}
