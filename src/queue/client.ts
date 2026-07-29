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

let deleteWorker: Worker<DeleteDmMessagePayload> | null = null
let purgeWorker: Worker<PurgeExpiredSecretPayload> | null = null

export function startWorkers(
  deleteProcessor: (job: { data: DeleteDmMessagePayload }) => Promise<void>,
  purgeProcessor: (job: { data: PurgeExpiredSecretPayload }) => Promise<void>,
): { deleteWorker: Worker<DeleteDmMessagePayload>; purgeWorker: Worker<PurgeExpiredSecretPayload> } {
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

  deleteWorker.on('error', (err) => logger.error({ err }, 'Delete worker error'))
  purgeWorker.on('error', (err) => logger.error({ err }, 'Purge worker error'))

  return { deleteWorker, purgeWorker }
}

export async function closeWorkers(): Promise<void> {
  if (deleteWorker) {
    await deleteWorker.close()
  }
  if (purgeWorker) {
    await purgeWorker.close()
  }
}
