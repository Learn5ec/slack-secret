import pino from 'pino'
import { loadConfig } from '../config'

const config = loadConfig()

export const logger = pino({
  level: config.LOG_LEVEL,
  transport: config.LOG_LEVEL !== 'error' && config.LOG_LEVEL !== 'fatal'
    ? { target: 'pino/file', options: { destination: 1 } }
    : undefined,
  redact: {
    paths: [
      'ciphertext',
      'nonce',
      'encryptedDataKey',
      'plaintext',
      'dataKey',
      'masterKey',
      'SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
      'SLACK_SIGNING_SECRET',
      'POSTGRES_PASSWORD',
      'MASTER_KEY_PASSPHRASE',
    ],
    remove: true,
  },
})

export type AppLogger = typeof logger
