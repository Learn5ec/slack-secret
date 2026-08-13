import { Queue, Worker } from 'bullmq'
import { loadConfig } from '../config'
import { logger } from '../utils/logger'

const config = loadConfig()

export interface DeleteDmMessagePayload {
  viewId: string
  secretId: string
}

export interface PurgeExpiredSecretPayload {
  secretId: string
  isConsumed: boolean
}

export interface ChannelDeliveryPayload {
  secretId: string
  channelId: string
  senderId: string
}

export const deleteDmMessageQueue = new Queue<DeleteDmMessagePayload>('delete-dm-message', {
  connection: { url: config.REDIS_URL },
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 50,
  },
})

export const purgeExpiredSecretQueue = new Queue<PurgeExpiredSecretPayload>('purge-expired-secret', {
  connection: { url: config.REDIS_URL },
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 50,
  },
})

export const channelDeliveryQueue = new Queue<ChannelDeliveryPayload>('channel-delivery', {
  connection: { url: config.REDIS_URL },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 50,
    removeOnFail: 20,
  },
})

let deleteWorker: Worker<DeleteDmMessagePayload> | null = null
let purgeWorker: Worker<PurgeExpiredSecretPayload> | null = null
let channelDeliveryWorker: Worker<ChannelDeliveryPayload> | null = null

export function startWorkers(
  deleteProcessor: (job: { data: DeleteDmMessagePayload }) => Promise<void>,
  purgeProcessor: (job: { data: PurgeExpiredSecretPayload }) => Promise<void>,
  channelDeliveryProcessor?: (job: { data: ChannelDeliveryPayload }) => Promise<void>,
): { deleteWorker: Worker<DeleteDmMessagePayload>; purgeWorker: Worker<PurgeExpiredSecretPayload>; channelDeliveryWorker: Worker<ChannelDeliveryPayload> | null } {
  deleteWorker = new Worker<DeleteDmMessagePayload>(
    'delete-dm-message',
    async (job) => {
      logger.info({ jobId: job.id, data: job.data }, 'Processing delete-dm-message job')
      await deleteProcessor(job)
    },
    { connection: { url: config.REDIS_URL } },
  )

  purgeWorker = new Worker<PurgeExpiredSecretPayload>(
    'purge-expired-secret',
    async (job) => {
      logger.info({ jobId: job.id, data: job.data }, 'Processing purge-expired-secret job')
      await purgeProcessor(job)
    },
    { connection: { url: config.REDIS_URL } },
  )

  if (channelDeliveryProcessor) {
    channelDeliveryWorker = new Worker<ChannelDeliveryPayload>(
      'channel-delivery',
      async (job) => {
        logger.info({ jobId: job.id, data: job.data }, 'Processing channel-delivery job')
        await channelDeliveryProcessor(job)
      },
      { connection: { url: config.REDIS_URL }, concurrency: 1 },
    )
    channelDeliveryWorker.on('error', (err) => logger.error({ err }, 'Channel delivery worker error'))
  }

  deleteWorker.on('error', (err) => logger.error({ err }, 'Delete worker error'))
  purgeWorker.on('error', (err) => logger.error({ err }, 'Purge worker error'))

  return { deleteWorker, purgeWorker, channelDeliveryWorker }
}

export async function closeWorkers(): Promise<void> {
  if (deleteWorker) {
    await deleteWorker.close()
  }
  if (purgeWorker) {
    await purgeWorker.close()
  }
  if (channelDeliveryWorker) {
    await channelDeliveryWorker.close()
  }
}
