// Public Roblox account shop endpoints used by the storefront:
//   GET /api/accounts               -> listings for sale (+ recently sold) with fresh avatar & game icons
//   GET /api/accounts/photo?key=…   -> an uploaded account screenshot
//   GET /api/trending               -> Roblox games trending / most played right now
import type { Config } from '@netlify/functions'
import { getDatabase } from '@netlify/database'
import { json } from '../lib/orders.mts'
import { PHOTO_KEY_RE, avatarThumbs, gameIcons, jsonList, photoStore, photoUrl, trendingGames } from '../lib/accounts.mts'

const db = getDatabase()

const cached = (body: unknown, cdnSeconds: number) =>
  new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=15',
      'netlify-cdn-cache-control': `public, s-maxage=${cdnSeconds}, stale-while-revalidate=${cdnSeconds * 4}`,
    },
  })

async function listAccounts() {
  const rows = await db.sql`
    SELECT id, universe_id, game_name, title, badge, roblox_user_id, account_created, price, strike_price,
           items, description, photos, status, created_at, sold_at,
           (reserved_invoice IS NOT NULL AND reserved_until > NOW()) AS reserved
    FROM account_listings
    WHERE status = 'available' OR (status = 'sold' AND sold_at > NOW() - INTERVAL '7 days')
    ORDER BY (status = 'sold'), created_at DESC
    LIMIT 400
  `
  const [avatars, icons] = await Promise.all([
    avatarThumbs(rows.map((r) => r.roblox_user_id)),
    gameIcons(rows.map((r) => r.universe_id)),
  ])
  return cached(
    {
      accounts: rows.map((r) => ({
        id: r.id,
        universeId: r.universe_id ? Number(r.universe_id) : null,
        game: r.game_name,
        gameIcon: icons.get(String(r.universe_id)) || null,
        title: r.title,
        badge: r.badge,
        avatar: avatars.get(String(r.roblox_user_id)) || null,
        accountCreated: r.account_created,
        price: r.price,
        strikePrice: r.strike_price,
        items: jsonList(r.items),
        description: r.description,
        photos: jsonList(r.photos).map(photoUrl),
        status: r.status === 'sold' ? 'sold' : r.reserved ? 'reserved' : 'available',
        createdAt: r.created_at,
      })),
    },
    30,
  )
}

async function getPhoto(req: Request) {
  const key = new URL(req.url).searchParams.get('key') || ''
  if (!PHOTO_KEY_RE.test(key)) return json({ error: 'invalid_key' }, 400)
  const result = await photoStore().getWithMetadata(key, { type: 'arrayBuffer' })
  if (!result) return json({ error: 'not_found' }, 404)
  return new Response(result.data, {
    headers: {
      'content-type': String(result.metadata?.type || 'image/jpeg'),
      'cache-control': 'public, max-age=31536000, immutable',
    },
  })
}

async function trending() {
  try {
    return cached({ games: await trendingGames() }, 1800)
  } catch (err) {
    console.error('trending lookup failed', err)
    return json({ games: [] })
  }
}

export default async (req: Request) => {
  const { pathname } = new URL(req.url)
  if (req.method !== 'GET') return json({ error: 'not_found' }, 404)
  try {
    if (pathname === '/api/accounts') return await listAccounts()
    if (pathname === '/api/accounts/photo') return await getPhoto(req)
    if (pathname === '/api/trending') return await trending()
    return json({ error: 'not_found' }, 404)
  } catch (err) {
    console.error('accounts endpoint failed', err)
    return json({ error: 'server_error' }, 500)
  }
}

export const config: Config = {
  path: ['/api/accounts', '/api/accounts/photo', '/api/trending'],
}
