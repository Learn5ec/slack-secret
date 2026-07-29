import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const envSchema = z.object({
  SLACK_APP_TOKEN: z.string().startsWith('xapp-'),
  SLACK_BOT_TOKEN: z.string().startsWith('xoxb-'),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_TEAM_ID: z.string().startsWith('T'),
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().default(5432),
  POSTGRES_DB: z.string().default('secret_bot'),
  POSTGRES_USER: z.string().default('secret_bot'),
  POSTGRES_PASSWORD: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  MASTER_KEY_FILE: z.string().default('./src/crypto/keys/master.key.age'),
  MASTER_KEY_PASSPHRASE: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(): Config {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    throw new Error(`Configuration error:\n${result.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`)
  }
  return result.data
}
