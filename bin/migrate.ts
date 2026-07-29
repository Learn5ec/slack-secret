import dotenv from 'dotenv'
dotenv.config()

const config = {
  POSTGRES_HOST: process.env.POSTGRES_HOST || 'localhost',
  POSTGRES_PORT: parseInt(process.env.POSTGRES_PORT || '5432'),
  POSTGRES_DB: process.env.POSTGRES_DB || 'secret_bot',
  POSTGRES_USER: process.env.POSTGRES_USER || 'secret_bot',
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD || '',
}
const { Pool } = require('pg')

async function runMigration() {
  const fs = require('fs')
  const path = require('path')

  const migrationsDir = path.join(__dirname, '../src/db/migrations')
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f: string) => f.endsWith('.sql'))
    .sort()

  const pool = new Pool({
    host: config.POSTGRES_HOST,
    port: config.POSTGRES_PORT,
    database: config.POSTGRES_DB,
    user: config.POSTGRES_USER,
    password: config.POSTGRES_PASSWORD,
  })

  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8')
      console.log(`Applying ${file}...`)
      await pool.query(sql)
    }
    console.log('All migrations applied successfully.')
  } finally {
    await pool.end()
  }
}

runMigration().catch((err: Error) => {
  console.error('Migration failed:', err.message)
  process.exit(1)
})
