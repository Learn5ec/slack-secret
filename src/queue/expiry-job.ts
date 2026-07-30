import { WebClient } from '@slack/web-api'
import fs from 'fs'
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
    // Get the secret to check if it's a file type
    const secret = await secretsRepo.getSecretById(secretId)
    if (!secret) {
      logger.warn({ secretId }, 'Secret not found for expiry')
      return
    }

    // Delete local encrypted file if this secret carries a file
    if (secret.file_path) {
      try {
        await fs.promises.unlink(secret.file_path)
        logger.info({ secretId, filePath: secret.file_path }, 'Deleted local encrypted file on expiry')
      } catch (err: any) {
        logger.warn({ err, secretId, filePath: secret.file_path }, 'Failed to delete local encrypted file on expiry')
      }
    }

    await secretsRepo.updateSecretStatus(secretId, 'expired')
    logger.info({ secretId, isConsumed }, 'Secret expired')
  } catch (err: any) {
    logger.error({ err, secretId }, 'Failed to expire secret')
    throw err
  }
}
