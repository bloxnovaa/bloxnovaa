// Shared helpers for the order + payment-proof endpoints.
import { createHash, timingSafeEqual } from 'node:crypto'
import { getStore } from '@netlify/blobs'

// SHA-256 of the admin vault password (same password the storefront always used).
// Can be overridden with the ADMIN_PASSWORD_HASH environment variable.
const DEFAULT_ADMIN_HASH = '519fc71ff4252297d4b283e79d2d29839cb92d6bc3d07b8e27c05b238fa01db6'

export const INVOICE_RE = /^BNX-[A-F0-9]{12}$/
export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/
export const STATUSES = ['waiting_proof', 'proof_sent', 'done', 'rejected'] as const

// Strong consistency so the admin can open a proof the moment it is uploaded.
export const proofStore = () => getStore({ name: 'payment-proofs', consistency: 'strong' })

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

export function isAdmin(req: Request) {
  const password = req.headers.get('x-admin-password') || ''
  if (!password) return false
  const expected = Buffer.from(process.env.ADMIN_PASSWORD_HASH || DEFAULT_ADMIN_HASH, 'hex')
  const actual = createHash('sha256').update(password.trim()).digest()
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

const clip = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max)

// Validates the order fields sent by the storefront; returns null when invalid.
export function parseOrder(input: Record<string, unknown>) {
  const invoice = clip(input.invoice, 20)
  const username = clip(input.username, 20)
  const total = Number(input.total)
  const pkg = clip(input.package, 40)
  if (!INVOICE_RE.test(invoice) || !USERNAME_RE.test(username) || !pkg) return null
  if (!Number.isSafeInteger(total) || total < 25000 || total > 100_000_000) return null
  return {
    invoice,
    username,
    package: pkg,
    accountType: clip(input.accountType, 60),
    total,
    language: input.language === 'en' ? 'en' : 'id',
    // Set when the buyer is purchasing a Roblox account from the shop instead of Robux.
    listingId: Number.isSafeInteger(Number(input.listingId)) && Number(input.listingId) > 0 ? Number(input.listingId) : null,
    // WhatsApp number or Telegram handle; anything else is stripped.
    contact: clip(input.contact, 60).replace(/[^\w@+.\- ]/g, '').trim(),
  }
}
