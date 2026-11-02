// Web Push helpers: VAPID keys, subscription storage and delivery to the OS notification bar.
import webpush from 'web-push'
import { getStore } from '@netlify/blobs'
import { getDatabase } from '@netlify/database'

const db = getDatabase()
const SUBJECT = 'mailto:support@rebelstoreee.store'

type Vapid = { publicKey: string; privateKey: string }
let vapidCache: Promise<Vapid> | null = null

// Uses VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY when set, otherwise generates a key pair once and keeps it in Blobs.
async function loadVapid(): Promise<Vapid> {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) return { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY }
  const store = getStore({ name: 'push-config', consistency: 'strong' })
  const existing = (await store.get('vapid', { type: 'json' })) as Vapid | null
  if (existing?.publicKey) return existing
  await store.setJSON('vapid', webpush.generateVAPIDKeys(), { onlyIfNew: true })
  return (await store.get('vapid', { type: 'json' })) as Vapid
}

export function getVapid() {
  vapidCache ??= loadVapid().catch((err) => {
    vapidCache = null
    throw err
  })
  return vapidCache
}

export type PushPayload = {
  title: string
  body: string
  tag?: string
  url?: string
  kind?: 'admin' | 'done' | 'rejected'
}

type SubRow = { id: number; endpoint: string; p256dh: string; auth: string }

async function deliver(rows: SubRow[], payload: PushPayload) {
  if (!rows.length) return
  const vapid = await getVapid()
  const options = { vapidDetails: { subject: SUBJECT, ...vapid }, TTL: 60 * 60 * 24, urgency: 'high' as const }
  const gone: number[] = []
  await Promise.all(
    rows.map((r) =>
      webpush
        .sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, JSON.stringify(payload), options)
        .catch((err) => {
          if (err?.statusCode === 404 || err?.statusCode === 410) gone.push(r.id)
          else console.warn('push failed', err?.statusCode || err)
        }),
    ),
  )
  if (gone.length) await db.sql`DELETE FROM push_subscriptions WHERE id = ANY(${gone})`
}

export async function notifyAdmins(payload: PushPayload) {
  try {
    const rows = await db.sql`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE role = 'admin'`
    await deliver(rows as SubRow[], { kind: 'admin', url: '/?admin=1', ...payload })
  } catch (err) {
    console.error('notifyAdmins failed', err)
  }
}

type DecidedOrder = { invoice: string; username: string; package: string; total: number; language: string; status: string; listing_id?: number | null }

const rp = (n: number) => `Rp ${Number(n || 0).toLocaleString('id-ID')}`

function verdictPayload(o: DecidedOrder): PushPayload {
  const en = o.language === 'en'
  const ok = o.status === 'done'
  const title = ok
    ? en ? '✅ Payment approved!' : '✅ Pembayaran disetujui!'
    : en ? '❌ Transaction rejected' : '❌ Transaksi ditolak'
  const body = ok && o.listing_id
    ? en
      ? `${o.package} is yours! Tap to see the username & password. Invoice ${o.invoice}`
      : `${o.package} jadi milikmu! Ketuk untuk lihat username & password. Invoice ${o.invoice}`
    : ok
    ? en
      ? `${o.package} for @${o.username} is on its way. Invoice ${o.invoice}`
      : `${o.package} untuk @${o.username} sedang dikirim. Invoice ${o.invoice}`
    : en
      ? `We couldn't verify invoice ${o.invoice}. Tap to contact support.`
      : `Invoice ${o.invoice} (${rp(o.total)}) tidak dapat diverifikasi. Ketuk untuk detail.`
  return { title, body, tag: `order-${o.invoice}`, url: `/?order=${o.invoice}`, kind: ok ? 'done' : 'rejected' }
}

// Tells each buyer (on every device that subscribed to the invoice) about the admin's decision.
export async function notifyBuyers(orders: DecidedOrder[]) {
  try {
    const decided = orders.filter((o) => o.status === 'done' || o.status === 'rejected')
    if (!decided.length) return
    const rows = await db.sql`
      SELECT id, endpoint, p256dh, auth, invoice FROM push_subscriptions
      WHERE role = 'buyer' AND invoice = ANY(${decided.map((o) => o.invoice)})
    `
    const subs = rows as (SubRow & { invoice: string })[]
    await Promise.all(decided.map((o) => deliver(subs.filter((r) => r.invoice === o.invoice), verdictPayload(o))))
  } catch (err) {
    console.error('notifyBuyers failed', err)
  }
}

export const formatRupiah = rp
