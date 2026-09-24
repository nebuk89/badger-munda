import { Pool, type PoolClient } from 'pg'
import { requiredEnv } from '../env.js'

let pool: Pool | undefined

export function hostedPool() {
  pool ??= new Pool({
    connectionString: requiredEnv('DATABASE_URL'),
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
  return pool
}

export async function transaction<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await hostedPool().connect()
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
