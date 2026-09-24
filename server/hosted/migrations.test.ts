import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readMigrationFiles } from 'drizzle-orm/migrator'

const migrationFiles = [
  '0000_hosted_service.sql',
  '0001_badge_registry.sql',
  '0002_device_sync.sql',
]

describe('hosted database migrations', () => {
  it('discovers all SQL migrations in order', async () => {
    const migrations = readMigrationFiles({ migrationsFolder: './drizzle' })
    const expectedHashes = await Promise.all(migrationFiles.map(async (file) => {
      const sql = await readFile(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8')
      return createHash('sha256').update(sql).digest('hex')
    }))

    assert.equal(migrations.length, 3)
    assert.deepEqual(migrations.map(({ hash }) => hash), expectedHashes)
    assert.deepEqual(migrations.map(({ folderMillis }) => folderMillis), [
      1790183962000,
      1790184436000,
      1790185195000,
    ])
  })
})
