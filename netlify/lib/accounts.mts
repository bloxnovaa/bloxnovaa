// Shared helpers for the Roblox account shop: listing validation, reservations and Roblox lookups.
import { getStore } from '@netlify/blobs'
import { getDatabase } from '@netlify/database'

const db = getDatabase()

export const LISTING_STATUSES = ['available', 'sold', 'hidden'] as const
export const ITEM_TYPES = ['pet', 'baju', 'aksesoris', 'avatar', 'gamepass', 'senjata', 'lainnya'] as const
export const PHOTO_KEY_RE = /^L\d+-[a-f0-9]{16}$/
// Built-in listing photos shipped with the site (assets/accounts/*.webp).
export const STATIC_PHOTO_RE = /^\/assets\/accounts\/[a-z0-9-]+\.webp$/
export const photoUrl = (key: string) => (STATIC_PHOTO_RE.test(key) ? key : `/api/accounts/photo?key=${key}`)
export const MAX_PHOTOS = 4

// Account photos (inventory / pet screenshots) are public, so eventual consistency is fine.
export const photoStore = () => getStore({ name: 'account-photos' })

const clip = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max)

export type ListingItem = { type: string; name: string; rarity: string; qty: number }

export function parseItems(input: unknown): ListingItem[] {
  let list: unknown = input
  if (typeof input === 'string') {
    try { list = JSON.parse(input) } catch { list = [] }
  }
  if (!Array.isArray(list)) return []
  return list
    .slice(0, 80)
    .map((raw: any) => ({
      type: (ITEM_TYPES as readonly string[]).includes(raw?.type) ? raw.type : 'lainnya',
      name: clip(raw?.name, 60),
      rarity: clip(raw?.rarity, 30),
      qty: Math.min(9999, Math.max(1, Math.floor(Number(raw?.qty) || 1))),
    }))
    .filter((item) => item.name)
}

export const jsonList = (value: unknown) => {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
  }
  return []
}

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`Upstream ${res.status}`)
  return res.json()
}

// Thumbnail URLs from Roblox expire, so they are looked up fresh (in batches of 100) instead of stored.
async function thumbnails(kind: 'avatar' | 'icon', ids: (number | string)[]) {
  const unique = [...new Set(ids.filter(Boolean).map(String))]
  const map = new Map<string, string>()
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100).join(',')
    const url = kind === 'avatar'
      ? `https://thumbnails.roblox.com/v1/users/avatar?userIds=${chunk}&size=420x420&format=Png&isCircular=false`
      : `https://thumbnails.roblox.com/v1/games/icons?universeIds=${chunk}&size=150x150&format=Png&isCircular=false`
    try {
      const { data } = await fetchJson(url)
      for (const t of data || []) if (t.state === 'Completed' && t.imageUrl) map.set(String(t.targetId), t.imageUrl)
    } catch (err) {
      console.warn(`roblox ${kind} thumbnails failed`, err)
    }
  }
  return map
}

export const avatarThumbs = (userIds: (number | string)[]) => thumbnails('avatar', userIds)
export const gameIcons = (universeIds: (number | string)[]) => thumbnails('icon', universeIds)

export async function lookupRobloxUser(username: string) {
  const lookup = await fetchJson('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  })
  const match = lookup?.data?.[0]
  if (!match?.id) return null
  const profile = await fetchJson(`https://users.roblox.com/v1/users/${match.id}`).catch(() => ({}))
  return { id: Number(match.id), username: String(match.name), created: profile?.created || null }
}

type ExploreGame = { universeId: number; name: string; playerCount?: number }

async function exploreSort(sortId: string) {
  const session = crypto.randomUUID()
  const data = await fetchJson(
    `https://apis.roblox.com/explore-api/v1/get-sort-content?sessionId=${session}&sortId=${sortId}&device=computer&country=all`,
  )
  return (data?.games || []) as ExploreGame[]
}

// Trending first (biggest weekly growth), then the most played games right now.
export async function trendingGames(limit = 16) {
  const [trending, popular] = await Promise.allSettled([exploreSort('top-trending'), exploreSort('top-playing-now')])
  const seen = new Set<number>()
  const games: { universeId: number; name: string; players: number; trend: 'trending' | 'popular' }[] = []
  const add = (list: ExploreGame[], trend: 'trending' | 'popular') => {
    for (const g of list) {
      if (!g?.universeId || seen.has(g.universeId) || games.length >= limit) continue
      seen.add(g.universeId)
      games.push({ universeId: g.universeId, name: String(g.name || '').trim(), players: Number(g.playerCount) || 0, trend })
    }
  }
  if (trending.status === 'fulfilled') add(trending.value.slice(0, Math.ceil(limit / 2)), 'trending')
  if (popular.status === 'fulfilled') add(popular.value, 'popular')
  if (trending.status === 'fulfilled') add(trending.value, 'trending')
  const icons = await gameIcons(games.map((g) => g.universeId))
  return games.map((g) => ({ ...g, icon: icons.get(String(g.universeId)) || null }))
}

export async function searchGames(query: string) {
  const session = crypto.randomUUID()
  const data = await fetchJson(
    `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(query)}&sessionId=${session}&pageType=all`,
  )
  const games: { universeId: number; name: string; players: number }[] = []
  for (const group of data?.searchResults || []) {
    if (group?.contentGroupType !== 'Game') continue
    for (const g of group.contents || []) {
      if (g?.universeId && games.length < 10) games.push({ universeId: g.universeId, name: String(g.name || ''), players: Number(g.playerCount) || 0 })
    }
  }
  const icons = await gameIcons(games.map((g) => g.universeId))
  return games.map((g) => ({ ...g, icon: icons.get(String(g.universeId)) || null }))
}

// Holds an available listing for one invoice so two buyers can't pay for the same account.
// The admin can only approve the order once the account's login details are filled in.
// Returns the listing when the hold succeeded (or already belongs to this invoice), otherwise null.
export async function reserveListing(id: number, invoice: string, total: number, hours: number) {
  const [row] = await db.sql`
    UPDATE account_listings
    SET reserved_invoice = ${invoice}, reserved_until = NOW() + make_interval(hours => ${hours})
    WHERE id = ${id} AND status = 'available' AND price = ${total}
      AND (reserved_invoice IS NULL OR reserved_invoice = ${invoice} OR reserved_until < NOW())
    RETURNING id, title, game_name
  `
  return row || null
}

export const listingPackage = (row: Record<string, any>) =>
  clip(`Akun #${row.id}${row.game_name ? ` • ${row.game_name}` : ''}`, 40)
