import { App, SocketModeReceiver } from '@slack/bolt'
import { loadConfig } from './config'
import { logger } from './utils/logger'
import { pool, closePool } from './db/client'
import { createDatabases } from './db'
import { startWorkers, closeWorkers, deleteDmMessageQueue } from './queue/client'
import { processDeleteDmMessage } from './queue/delete-job'
import { processPurgeExpiredSecret } from './queue/expiry-job'
import { slackClient } from './slack/client'
import { handleSecretCommand } from './bot/commands'
import { handleModalSubmit } from './bot/modals'
import { handleViewAction, handleViewedByAction, handleCancelAction, handleHideAction, handleRevokeConfirm } from './bot/actions'
import { purgeSecret } from './bot/secret-cleanup'
import { startConfigPolling, stopConfigPolling, getConfig } from './config/timing'
import { initHealthCheck, closeHealthCheck } from './health'
import Redis from 'ioredis'

// Safety-net sweep: purge any secret that expired without ever being viewed
// or revoked (per-viewer view-once + Revoke handle the normal paths - this
// catches secrets nobody ever interacted with, which would otherwise sit in
// Postgres and on local disk forever).
async function sweepExpiredSecrets(dbs: ReturnType<typeof createDatabases>): Promise<void> {
  try {
    const expired = await dbs.secrets.getPendingSecrets()
    if (expired.length === 0) return

    logger.info({ count: expired.length }, 'Expiry sweep: purging expired secrets')
    for (const secret of expired) {
      try {
        await purgeSecret(slackClient, dbs, secret)
      } catch (err: any) {
        logger.error({ err, secretId: secret.id }, 'Expiry sweep: failed to purge secret')
      }
    }
  } catch (err: any) {
    logger.error({ err }, 'Expiry sweep failed')
  }
}

// Safety-net sweep: re-enqueue delete jobs for any view whose delete_at has
// passed but is still 'delivered' - guards against a lost/crashed BullMQ job
// (e.g. a Redis restart mid-flight) leaving a revealed secret undeleted.
async function sweepStragglerViews(viewsRepo: ReturnType<typeof createDatabases>['views']): Promise<void> {
  try {
    const stragglers = await viewsRepo.getDeliveredViewsDueForDeletion()
    if (stragglers.length === 0) return

    logger.warn({ count: stragglers.length }, 'Straggler sweep: re-enqueuing overdue view deletions')
    for (const view of stragglers) {
      await deleteDmMessageQueue.add(
        'delete-revealed-secret',
        { viewId: view.id, secretId: view.secret_id },
        { delay: 0 },
      )
    }
  } catch (err: any) {
    logger.error({ err }, 'Straggler sweep failed')
  }
}

async function main() {
  const config = loadConfig()

  logger.info('Starting secret-bot...')

  // Initialize Redis client
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    retryStrategy(times) {
      if (times > 3) {
        logger.error({ times }, 'Redis retry strategy exhausted')
        return null
      }
      return Math.min(times * 200, 2000)
    },
    lazyConnect: true,
  })

  redis.on('error', (err) => {
    logger.error({ err }, 'Redis connection error')
  })

  redis.connect()

  // Initialize health check server
  const HEALTH_PORT = config.HEALTH_PORT || 8080
  initHealthCheck(HEALTH_PORT, pool, redis)
  logger.info({ healthPort: HEALTH_PORT }, 'Health check initialized')

  // Initialize Bolt app with Socket Mode receiver
  const receiver = new SocketModeReceiver({
    appToken: config.SLACK_APP_TOKEN,
  })

  const app = new App({
    receiver,
    token: config.SLACK_BOT_TOKEN,
    signingSecret: config.SLACK_SIGNING_SECRET,
  })

  // Register slash command
  app.command('/secret', async ({ command, ack, respond, client }) => {
    await handleSecretCommand({
      command,
      ack: async () => ack(),
      respond: async (args) => respond(args as any),
      client: client as any,
    })
  })

  // Register modal submission handler
  app.view('secret_modal', async ({ view, ack, body, client }) => {
    await handleModalSubmit({
      view,
      ack,
      body,
      client: client as any,
    })
  })

  // Register action handlers
  app.action('secret:view', async (args) => {
    await handleViewAction({
      action: args.action as any,
      ack: args.ack,
      body: args.body as any,
      client: args.client as any,
    })
  })

  app.action('secret:viewed-by', async (args) => {
    await handleViewedByAction({
      action: args.action as any,
      ack: args.ack,
      body: args.body as any,
      client: args.client as any,
      respond: args.respond,
    })
  })

  app.action('secret:cancel', async (args) => {
    await handleCancelAction({
      action: args.action as any,
      ack: args.ack,
      body: args.body as any,
      client: args.client as any,
      trigger_id: (args.action as any).trigger_id,
    })
  })

  // Register modal submission handler for the revoke confirmation
  app.view('revoke_confirm', async ({ view, ack, body, client }) => {
    const secretId = (view as any).private_metadata
    const userId = (body.user as any)?.id

    if (!secretId) {
      logger.warn('Revoke confirm: no secretId in modal metadata')
      return
    }

    logger.info({ secretId, userId }, 'Revoke confirm: modal submitted')
    await handleRevokeConfirm({
      secretId,
      userId,
      trigger_id: (body as any).trigger_id || '',
      client: client as any,
    })
  })

  app.action('secret:hide', async (args) => {
    await handleHideAction({
      action: args.action as any,
      ack: args.ack,
      body: args.body as any,
      client: args.client as any,
    })
  })

  const dbs = createDatabases(pool)
  const { secrets: secretsRepo, views: viewsRepo } = dbs

  // Start config polling (re-reads config file every 60 seconds)
  startConfigPolling(60000)

  // Start workers
  const workers = startWorkers(
    async (job) => {
      await processDeleteDmMessage(job, slackClient, viewsRepo)
    },
    async (job) => {
      await processPurgeExpiredSecret(job, slackClient, secretsRepo)
    },
  )

  // Background safety-net sweeps - independent of the per-view/per-secret
  // BullMQ jobs, using our own Postgres as source of truth.
  const runtimeConfig = getConfig()
  const expirySweepInterval = setInterval(
    () => sweepExpiredSecrets(dbs),
    runtimeConfig.timing.expiry_check_interval_ms,
  )
  const stragglerSweepInterval = setInterval(
    () => sweepStragglerViews(viewsRepo),
    runtimeConfig.timing.delete_check_interval_ms,
  )

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down...')
    stopConfigPolling()
    clearInterval(expirySweepInterval)
    clearInterval(stragglerSweepInterval)
    await closeWorkers()
    await closeHealthCheck()
    await closePool()
    await redis.disconnect()
    process.exit(0)
  })

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down...')
    stopConfigPolling()
    clearInterval(expirySweepInterval)
    clearInterval(stragglerSweepInterval)
    await closeWorkers()
    await closeHealthCheck()
    await closePool()
    await redis.disconnect()
    process.exit(0)
  })

  // Start the app (Socket Mode doesn't need a port)
  await app.start()
  logger.info('secret-bot is running')
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start secret-bot')
  process.exit(1)
})
