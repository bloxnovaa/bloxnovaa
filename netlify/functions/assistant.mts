// Compatibility endpoint for older open tabs; new chats run in the browser.
import type { Config } from '@netlify/functions'
import { offlineReply } from '../../assets/shopping-guide.mjs'

const json = (body: unknown, status = 200) => Response.json(body, { status })

export default async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'not_found' }, 404)
  if (Number(req.headers.get('content-length')) > 48000) return json({ error: 'too_large' }, 413)
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || JSON.stringify(body).length > 48000) return json({ error: 'invalid_request' }, 400)
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .slice(-20)
    .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content.trim().slice(0, 1600) }))
  while (messages.length && messages[0].role !== 'user') messages.shift()
  if (!messages.length || messages[messages.length - 1].role !== 'user') return json({ error: 'invalid_request' }, 400)

  return json({ reply: offlineReply(messages, body.lang), mode: 'guide' })
}

export const config: Config = { path: '/api/assistant' }
