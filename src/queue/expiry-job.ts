import { WebClient } from '@slack/web-api'
import { logger } from '../utils/logger'
import { SecretsRepo } from '../db/secrets'
import { PurgeExpiredSecretPayload } from './client'

export async function processPurgeExpiredSecret(
  job: { data: PurgeExpiredSecretPayload },
  slackClient: WebClient,
  secretsRepo: SecretsRepo,
): Promise<void> {
  const { secretId, isConsumed } = job.data

  try {
    await secretsRepo.updateSecretStatus(secretId, 'expired')
    logger.info({ secretId, isConsumed }, 'Secret expired')
  } catch (err: any) {
    logger.error({ err, secretId }, 'Failed to expire secret')
    throw err
  }
}
