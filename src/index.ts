import { App, SocketModeReceiver } from '@slack/bolt'
import { loadConfig } from './config'
import { logger } from './utils/logger'
import { pool, closePool } from './db/client'
import { createDatabases } from './db'
import { startWorkers, closeWorkers } from './queue/client'
import { processDeleteDmMessage } from './queue/delete-job'
import { processPurgeExpiredSecret } from './queue/expiry-job'
import { slackClient } from './slack/client'
import { handleSecretCommand } from './bot/commands'
import { handleModalSubmit } from './bot/modals'
import { handleViewAction, handleViewedByAction, handleCancelAction, handleHideAction } from './bot/actions'
import { startConfigPolling, stopConfigPolling } from './config/timing'

async function main() {
  const config = loadConfig()

  logger.info('Starting secret-bot...')

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

  const { secrets: secretsRepo, views: viewsRepo } = createDatabases(pool)

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

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down...')
    stopConfigPolling()
    await closeWorkers()
    await closePool()
    process.exit(0)
  })

  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down...')
    stopConfigPolling()
    await closeWorkers()
    await closePool()
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
