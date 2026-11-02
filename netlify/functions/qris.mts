// GET /api/qris?amount=50000 -> PNG of the DevUtility QRIS with the amount embedded,
// so buyers only scan and confirm instead of typing the amount themselves.
import type { Config } from '@netlify/functions'
import QRCode from 'qrcode'
import { json } from '../lib/orders.mts'

// Payload decoded from the printed DevUtility static QRIS (NMID ID1025401517715).
const STATIC_PAYLOAD =
  '00020101021126570011ID.DANA.WWW011893600915390139121602099013912160303UMI51440014ID.CO.QRIS.WWW0215ID10254015177150303UMI5204581353033605802ID5910DevUtility6010Kab. Bogor6105163106304FDC9'

// CRC16-CCITT (poly 0x1021, init 0xFFFF), as required by the QRIS / EMVCo spec.
function crc16(input: string) {
  let crc = 0xffff
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

// Turns the static payload into a single-use one: point of initiation 12 + tag 54 (amount).
export function qrisWithAmount(amount: number) {
  const value = String(amount)
  const body = STATIC_PAYLOAD.slice(0, -8) // drop "6304" + old CRC
    .replace('010211', '010212')
    .replace('5802ID', `54${String(value.length).padStart(2, '0')}${value}5802ID`)
  const withCrcTag = `${body}6304`
  return withCrcTag + crc16(withCrcTag)
}

export default async (req: Request) => {
  const amount = Number(new URL(req.url).searchParams.get('amount'))
  if (!Number.isSafeInteger(amount) || amount < 25000 || amount > 100_000_000) {
    return json({ error: 'invalid_amount' }, 400)
  }
  const png = await QRCode.toBuffer(qrisWithAmount(amount), {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 3,
    width: 720,
  })
  return new Response(png, {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400, immutable' },
  })
}

export const config: Config = { path: '/api/qris' }
