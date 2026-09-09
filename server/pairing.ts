import { isIPv4 } from 'node:net'

export function pairingAddress(localAddress: string | undefined, port: number) {
  const address = localAddress?.replace(/^::ffff:/i, '')
  if (!address || !isIPv4(address) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Pairing screen needs the Mac’s IPv4 address. Connect the badge to the station’s LAN IPv4 address.')
  }
  return `${address}:${port}`
}

export function pairingSvg(pin: string, address: string) {
  if (!/^\d{6}$/.test(pin) || !/^[\d.:]+$/.test(address)) throw new Error('Invalid pairing screen configuration.')
  const addressSize = Math.min(11, 142 / (address.length * 0.64))
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120">
    <rect width="160" height="120" fill="#171912"/>
    <rect x="3" y="3" width="154" height="114" fill="none" stroke="#e8ba43" stroke-width="2"/>
    <rect x="7" y="7" width="146" height="16" fill="#e8ba43"/>
    <text x="80" y="18" text-anchor="middle" fill="#171912" font-family="sans-serif" font-size="9" font-weight="bold">WI-FI CONNECTED</text>
    <text x="80" y="35" text-anchor="middle" fill="#f9efce" font-family="sans-serif" font-size="9">On phone, open http://</text>
    <text x="80" y="49" text-anchor="middle" fill="#f9efce" font-family="monospace" font-size="${addressSize}" font-weight="bold">${address}</text>
    <text x="80" y="64" text-anchor="middle" fill="#e8ba43" font-family="sans-serif" font-size="9">ENTER PAIRING CODE</text>
    <text x="80" y="96" text-anchor="middle" fill="#f9efce" font-family="monospace" font-size="36" font-weight="bold">${pin}</text>
    <text x="80" y="111" text-anchor="middle" fill="#e8ba43" font-family="sans-serif" font-size="9">Waiting for your phone</text>
  </svg>`)
}
