// Daily exchange rates (units of each currency per 1 USD) for the international store.
// Prices are still charged in rupiah via QRIS; these rates only power the local-currency display.
import type { Config } from '@netlify/functions'

export default async () => {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(6000) })
    if (!res.ok) throw new Error(`Upstream ${res.status}`)
    const data = await res.json()
    if (data?.result !== 'success' || typeof data.rates !== 'object') throw new Error('Bad payload')
    return new Response(JSON.stringify({ rates: data.rates, updated: data.time_last_update_utc }), {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=3600',
        'netlify-cdn-cache-control': 'public, s-maxage=21600, stale-while-revalidate=86400',
      },
    })
  } catch {
    return new Response(JSON.stringify({ error: 'rates_unavailable' }), {
      status: 502,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }
}

export const config: Config = { path: '/api/fx' }
