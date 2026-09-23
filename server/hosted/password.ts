import { randomBytes, scrypt as scryptCallback } from 'node:crypto'
import { equalText } from './crypto.ts'

const N = 16384
const r = 8
const p = 1
const length = 64

function scrypt(password: string, salt: Buffer, size: number, options: { N: number; r: number; p: number; maxmem: number }) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, size, options, (error, result) => {
      if (error) reject(error)
      else resolve(result)
    })
  })
}

export async function hashPassword(password: string) {
  if (password.length < 12 || password.length > 256) {
    throw new Error('The admin password must contain 12 to 256 characters.')
  }
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, length, { N, r, p, maxmem: 64 * 1024 * 1024 })
  return `$scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export async function verifyPassword(password: string, encoded: string) {
  const parts = encoded.split('$')
  if (parts.length !== 7 || parts[1] !== 'scrypt') return false
  const [, , nText, rText, pText, saltText, hashText] = parts
  const parameters = [nText, rText, pText].map(Number)
  if (parameters.some((value) => !Number.isSafeInteger(value) || value <= 0)) return false
  const expected = Buffer.from(hashText, 'base64url')
  if (expected.length !== length) return false
  const actual = await scrypt(password, Buffer.from(saltText, 'base64url'), expected.length, {
    N: parameters[0],
    r: parameters[1],
    p: parameters[2],
    maxmem: 64 * 1024 * 1024,
  })
  return equalText(actual.toString('hex'), expected.toString('hex'))
}
