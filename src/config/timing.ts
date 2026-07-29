import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../utils/logger'

export type TimingConfig = {
  secret_expiry_ms: number
  delete_after_view_ms: number
  expiry_check_interval_ms: number
  delete_check_interval_ms: number
}

export type SecurityConfig = {
  max_secret_length: number
  max_recipients: number
  allow_multi_viewer: boolean
}

export type BehaviorConfig = {
  sender_sees_buttons: boolean
  recipient_sees_only_view: boolean
  auto_revoke_on_expiry: boolean
  notify_on_cancel: boolean
}

export type SecretBotConfig = {
  version: number
  updated_at: string
  timing: TimingConfig
  security: SecurityConfig
  behavior: BehaviorConfig
}

const CONFIG_PATH = path.join(__dirname, '../../config/secret-bot-config.json')

let currentConfig: SecretBotConfig | null = null
let lastConfigJson: string | null = null
let pollInterval: NodeJS.Timeout | null = null

function loadConfigFromFile(): SecretBotConfig {
  try {
    const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8')
    const rawConfig = JSON.parse(fileContents)

    return {
      version: rawConfig.version,
      updated_at: rawConfig.updated_at,
      timing: {
        secret_expiry_ms: (rawConfig.timing.secret_expiry_seconds || 3600) * 1000,
        delete_after_view_ms: (rawConfig.timing.delete_after_view_seconds || 300) * 1000,
        expiry_check_interval_ms: (rawConfig.timing.expiry_check_interval_seconds || 60) * 1000,
        delete_check_interval_ms: (rawConfig.timing.delete_check_interval_seconds || 30) * 1000,
      },
      security: {
        max_secret_length: rawConfig.security.max_secret_length || 3000,
        max_recipients: rawConfig.security.max_recipients || 1,
        allow_multi_viewer: rawConfig.security.allow_multi_viewer !== false,
      },
      behavior: {
        sender_sees_buttons: rawConfig.behavior.sender_sees_buttons !== false,
        recipient_sees_only_view: rawConfig.behavior.recipient_sees_only_view !== false,
        auto_revoke_on_expiry: rawConfig.behavior.auto_revoke_on_expiry !== false,
        notify_on_cancel: rawConfig.behavior.notify_on_cancel !== false,
      },
    }
  } catch (err: any) {
    logger.error({ err, configPath: CONFIG_PATH }, 'Failed to load config file, using defaults')
    return getDefaultConfig()
  }
}

function getDefaultConfig(): SecretBotConfig {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    timing: {
      secret_expiry_ms: 3600000,
      delete_after_view_ms: 300000,
      expiry_check_interval_ms: 60000,
      delete_check_interval_ms: 30000,
    },
    security: {
      max_secret_length: 3000,
      max_recipients: 1,
      allow_multi_viewer: true,
    },
    behavior: {
      sender_sees_buttons: true,
      recipient_sees_only_view: true,
      auto_revoke_on_expiry: true,
      notify_on_cancel: true,
    },
  }
}

export function getConfig(): SecretBotConfig {
  if (!currentConfig) {
    currentConfig = loadConfigFromFile()
    lastConfigJson = JSON.stringify(currentConfig)
    logger.info({ configPath: CONFIG_PATH, version: currentConfig.version }, 'Config loaded')
  }
  return currentConfig
}

export function startConfigPolling(intervalMs: number = 60000): void {
  if (pollInterval) {
    clearInterval(pollInterval)
  }

  pollInterval = setInterval(() => {
    try {
      const newConfig = loadConfigFromFile()
      const newConfigJson = JSON.stringify(newConfig)
      // Compare full content, not just `version` - operators editing the JSON
      // by hand routinely forget to bump version, which would otherwise mean
      // the edit silently never takes effect until a restart.
      if (newConfigJson !== lastConfigJson) {
        currentConfig = newConfig
        lastConfigJson = newConfigJson
        logger.info({ version: newConfig.version, updated_at: newConfig.updated_at }, 'Config reloaded from file (content changed)')
      }
    } catch (err: any) {
      logger.error({ err }, 'Failed to reload config')
    }
  }, intervalMs)

  logger.info({ intervalMs }, 'Config polling started')
}

export function stopConfigPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
    logger.info('Config polling stopped')
  }
}

export function getConfigPath(): string {
  return CONFIG_PATH
}
