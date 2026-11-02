// Looks up a Roblox account by username and returns public profile data + avatar.
// Roblox APIs do not allow browser CORS, so the storefront scanner calls this proxy.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': status === 200 ? 'public, max-age=300' : 'no-store',
    },
  })

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`Upstream ${res.status}`)
  return res.json()
}

export default async (req: Request) => {
  const username = (new URL(req.url).searchParams.get('username') || '').trim()
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return json({ error: 'invalid_username' }, 400)
  }

  try {
    const lookup = await fetchJson('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    })
    const match = lookup?.data?.[0]
    if (!match?.id) return json({ error: 'not_found' }, 404)

    const id = match.id
    const [profile, headshot, friends] = await Promise.allSettled([
      fetchJson(`https://users.roblox.com/v1/users/${id}`),
      fetchJson(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`),
      fetchJson(`https://friends.roblox.com/v1/users/${id}/friends/count`),
    ])

    const p = profile.status === 'fulfilled' ? profile.value : {}
    const thumb = headshot.status === 'fulfilled' ? headshot.value?.data?.[0] : null

    return json({
      id,
      username: match.name,
      displayName: match.displayName || p.displayName || match.name,
      verifiedBadge: Boolean(match.hasVerifiedBadge ?? p.hasVerifiedBadge),
      created: p.created || null,
      isBanned: Boolean(p.isBanned),
      avatar: thumb?.state === 'Completed' ? thumb.imageUrl : null,
      friends: friends.status === 'fulfilled' ? friends.value?.count ?? null : null,
    })
  } catch {
    return json({ error: 'upstream_unavailable' }, 502)
  }
}

export const config = { path: '/api/roblox-user' }
