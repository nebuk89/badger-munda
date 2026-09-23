import assert from 'node:assert/strict'
import test from 'node:test'
import { hashPassword, verifyPassword } from './password.ts'

test('admin password hashes are salted and reject the wrong password', async () => {
  const first = await hashPassword('correct horse battery staple')
  const second = await hashPassword('correct horse battery staple')
  assert.notEqual(first, second)
  assert.equal(await verifyPassword('correct horse battery staple', first), true)
  assert.equal(await verifyPassword('wrong password value', first), false)
  assert.equal(await verifyPassword('correct horse battery staple', 'invalid'), false)
})
