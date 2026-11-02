// Password-protected account shop management (header: x-admin-password):
//   GET    /api/admin/accounts        -> every listing, including the private account username
//   POST   /api/admin/accounts        -> create (no id) or update (id) a listing; multipart form with photos
//   PATCH  /api/admin/accounts        -> { id, status } quick status change (available / sold / hidden)
//   DELETE /api/admin/accounts?id=…   -> removes a listing and its photos
//   GET    /api/admin/games?q=…       -> Roblox game search for the listing form
import type { Config } from '@netlify/functions'
import { getDatabase } from '@netlify/database'
import { USERNAME_RE, isAdmin, json } from '../lib/orders.mts'
import {
  LISTING_STATUSES,
  MAX_PHOTOS,
  PHOTO_KEY_RE,
  avatarThumbs,
  jsonList,
  lookupRobloxUser,
  parseItems,
  photoStore,
  searchGames,
} from '../lib/accounts.mts'

const db = getDatabase()
const MAX_PHOTO_BYTES = 4 * 1024 * 1024
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

const clip = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max)
const price = (value: unknown) => {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

async function listAccounts() {
  const rows = await db.sql`
    SELECT id, universe_id, game_name, title, badge, account_username, roblox_user_id, account_created, price, strike_price,
           items, description, photos, status, created_at, sold_at, reserved_invoice, login_password, login_note,
           (reserved_invoice IS NOT NULL AND reserved_until > NOW()) AS reserved
    FROM account_listings
    ORDER BY (status = 'available') DESC, created_at DESC
    LIMIT 500
  `
  const avatars = await avatarThumbs(rows.map((r) => r.roblox_user_id))
  return json({
    accounts: rows.map((r) => ({
      id: r.id,
      universeId: r.universe_id ? Number(r.universe_id) : null,
      game: r.game_name,
      title: r.title,
      badge: r.badge,
      accountUsername: r.account_username,
      loginPassword: r.login_password,
      loginNote: r.login_note,
      avatar: avatars.get(String(r.roblox_user_id)) || null,
      accountCreated: r.account_created,
      price: r.price,
      strikePrice: r.strike_price,
      items: jsonList(r.items),
      description: r.description,
      photos: jsonList(r.photos),
      status: r.status,
      reservedInvoice: r.reserved ? r.reserved_invoice : null,
      createdAt: r.created_at,
      soldAt: r.sold_at,
    })),
  })
}

async function saveAccount(req: Request) {
  const form = await req.formData().catch(() => null)
  if (!form) return json({ error: 'invalid_form' }, 400)

  const id = form.get('id') ? Number(form.get('id')) : null
  if (id !== null && !Number.isSafeInteger(id)) return json({ error: 'invalid_id' }, 400)
  const title = clip(form.get('title'), 80)
  const listingPrice = price(form.get('price'))
  const strike = price(form.get('strikePrice'))
  const universeId = price(form.get('universeId'))
  const gameName = clip(form.get('gameName'), 60)
  if (!title) return json({ error: 'missing_title' }, 400)
  // QRIS payments start at Rp25.000, so cheaper listings could never be paid.
  if (!listingPrice || listingPrice < 25000 || listingPrice > 100_000_000) return json({ error: 'invalid_price' }, 400)
  if (!gameName) return json({ error: 'missing_game' }, 400)

  const [existing] = id
    ? await db.sql`SELECT id, account_username, roblox_user_id, account_created, photos FROM account_listings WHERE id = ${id}`
    : [null]
  if (id && !existing) return json({ error: 'not_found' }, 404)

  // Resolve the account's avatar from its username (only when it changed).
  const accountUsername = clip(form.get('accountUsername'), 20).replace(/^@/, '')
  let user = existing ? { id: existing.roblox_user_id, username: existing.account_username, created: existing.account_created } : null
  if (!accountUsername) user = null
  else if (!existing || accountUsername.toLowerCase() !== String(existing.account_username).toLowerCase()) {
    if (!USERNAME_RE.test(accountUsername)) return json({ error: 'invalid_username' }, 400)
    user = await lookupRobloxUser(accountUsername).catch(() => undefined as any)
    if (user === undefined) return json({ error: 'roblox_unavailable' }, 502)
    if (!user) return json({ error: 'account_not_found' }, 404)
  }

  // Photos: keep the ones the admin left in place, then append new uploads.
  const previous: string[] = existing ? jsonList(existing.photos) : []
  const keep = jsonList(form.get('keepPhotos')).filter((k: unknown) => typeof k === 'string' && previous.includes(k))
  const files = form.getAll('photos').filter((f): f is File => f instanceof File && f.size > 0)
  for (const f of files) {
    if (f.size > MAX_PHOTO_BYTES) return json({ error: 'photo_too_large' }, 413)
    if (!IMAGE_TYPES.includes(f.type)) return json({ error: 'invalid_photo_type' }, 415)
  }
  if (keep.length + files.length > MAX_PHOTOS) return json({ error: 'too_many_photos' }, 400)

  const fields = {
    universeId,
    gameName,
    title,
    badge: clip(form.get('badge'), 20),
    items: JSON.stringify(parseItems(form.get('items'))),
    description: clip(form.get('description'), 1500),
    strike: strike && strike > listingPrice ? strike : null,
    loginPassword: clip(form.get('loginPassword'), 120),
    loginNote: clip(form.get('loginNote'), 500),
  }

  const [row] = id
    ? await db.sql`
        UPDATE account_listings SET
          universe_id = ${fields.universeId}, game_name = ${fields.gameName}, title = ${fields.title}, badge = ${fields.badge},
          account_username = ${user?.username || ''}, roblox_user_id = ${user?.id || null}, account_created = ${user?.created || null},
          price = ${listingPrice}, strike_price = ${fields.strike}, items = ${fields.items}::jsonb, description = ${fields.description},
          login_password = ${fields.loginPassword}, login_note = ${fields.loginNote}
        WHERE id = ${id}
        RETURNING id
      `
    : await db.sql`
        INSERT INTO account_listings (universe_id, game_name, title, badge, account_username, roblox_user_id, account_created,
                                      price, strike_price, items, description, login_password, login_note)
        VALUES (${fields.universeId}, ${fields.gameName}, ${fields.title}, ${fields.badge}, ${user?.username || ''}, ${user?.id || null},
                ${user?.created || null}, ${listingPrice}, ${fields.strike}, ${fields.items}::jsonb, ${fields.description},
                ${fields.loginPassword}, ${fields.loginNote})
        RETURNING id
      `

  const store = photoStore()
  const added: string[] = []
  for (const f of files) {
    const key = `L${row.id}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
    await store.set(key, await f.arrayBuffer(), { metadata: { type: f.type } })
    added.push(key)
  }
  const photos = [...keep, ...added]
  await db.sql`UPDATE account_listings SET photos = ${JSON.stringify(photos)}::jsonb WHERE id = ${row.id}`
  await Promise.all(previous.filter((k) => !photos.includes(k) && PHOTO_KEY_RE.test(k)).map((k) => store.delete(k)))

  return json({ ok: true, id: row.id }, id ? 200 : 201)
}

async function setStatus(req: Request) {
  const { id, status } = await req.json().catch(() => ({}))
  if (!Number.isSafeInteger(id) || !LISTING_STATUSES.includes(status)) return json({ error: 'invalid_request' }, 400)
  const [row] = await db.sql`
    UPDATE account_listings SET
      status = ${status},
      sold_at = CASE WHEN ${status}::text = 'sold' THEN COALESCE(sold_at, NOW()) ELSE NULL END,
      reserved_invoice = CASE WHEN ${status}::text = 'sold' THEN reserved_invoice ELSE NULL END,
      reserved_until = CASE WHEN ${status}::text = 'sold' THEN reserved_until ELSE NULL END
    WHERE id = ${id}
    RETURNING id
  `
  if (!row) return json({ error: 'not_found' }, 404)
  return json({ ok: true })
}

async function deleteAccount(req: Request) {
  const id = Number(new URL(req.url).searchParams.get('id'))
  if (!Number.isSafeInteger(id)) return json({ error: 'invalid_id' }, 400)
  const [row] = await db.sql`DELETE FROM account_listings WHERE id = ${id} RETURNING photos`
  if (!row) return json({ error: 'not_found' }, 404)
  const store = photoStore()
  await Promise.all(jsonList(row.photos).filter((k: string) => PHOTO_KEY_RE.test(k)).map((k: string) => store.delete(k)))
  return json({ ok: true })
}

async function findGames(req: Request) {
  const q = clip(new URL(req.url).searchParams.get('q'), 60)
  if (q.length < 2) return json({ games: [] })
  try {
    return json({ games: await searchGames(q) })
  } catch (err) {
    console.warn('game search failed', err)
    return json({ error: 'roblox_unavailable' }, 502)
  }
}

export default async (req: Request) => {
  if (!isAdmin(req)) return json({ error: 'unauthorized' }, 401)
  const { pathname } = new URL(req.url)
  try {
    if (pathname === '/api/admin/games' && req.method === 'GET') return await findGames(req)
    if (pathname === '/api/admin/accounts') {
      if (req.method === 'GET') return await listAccounts()
      if (req.method === 'POST') return await saveAccount(req)
      if (req.method === 'PATCH') return await setStatus(req)
      if (req.method === 'DELETE') return await deleteAccount(req)
    }
    return json({ error: 'not_found' }, 404)
  } catch (err) {
    console.error('admin accounts endpoint failed', err)
    return json({ error: 'server_error' }, 500)
  }
}

export const config: Config = {
  path: ['/api/admin/accounts', '/api/admin/games'],
}
