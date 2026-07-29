import { Pool, PoolConfig } from 'pg'
import { loadConfig } from '../config'
import { logger } from '../utils/logger'

const config = loadConfig()

const poolConfig: PoolConfig = {
  host: config.POSTGRES_HOST,
  port: config.POSTGRES_PORT,
  database: config.POSTGRES_DB,
  user: config.POSTGRES_USER,
  password: config.POSTGRES_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
}

export const pool = new Pool(poolConfig)

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on pg pool')
})

export async function closePool(): Promise<void> {
  await pool.end()
}
