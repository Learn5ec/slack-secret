import { WebClient } from '@slack/web-api'
import fs from 'fs'
import { logger } from '../utils/logger'
import { deleteSlackMessage, deleteSlackFile } from '../slack/messages'
import { deleteDmMessageQueue } from '../queue/client'

// Full teardown of a secret: every revealed message/file for every viewer,
// the recipient placeholder, the Viewed By message, the sender's own
// placeholder, the local encrypted file, and finally the DB rows themselves.
// Used by both an explicit Revoke click (which has the live placeholder
// ts/channel from the click itself) and the background expiry sweep (which
// only has whatever was persisted on the secret row at creation time).
export async function purgeSecret(
  client: WebClient,
  dbs: any,
  secret: any,
  placeholder?: { channelId: string; ts: string },
): Promise<void> {
  const secretId = secret.id

  const views = await dbs.views.getDeliveredViewsForSecret(secretId)
  logger.info({ secretId, viewCount: views.length }, 'Purging secret: found views')

  for (const view of views) {
    if (!view.dm_channel_id) {
      logger.warn({ viewId: view.id }, 'View has no dm_channel_id, cannot delete message(s)')
      continue
    }
    if (view.dm_ts) {
      await deleteSlackMessage(client, view.dm_channel_id, view.dm_ts)
    }
    if (view.file_upload_id) {
      // Purge the actual file object first - chat.delete below only removes
      // the sharing message, not the underlying file.
      await deleteSlackFile(client, view.file_upload_id)
    }
    if (view.file_dm_ts) {
      await deleteSlackMessage(client, view.dm_channel_id, view.file_dm_ts)
    }
  }

  // Cancel any pending auto-delete jobs for this secret's views
  const pendingJobs = await deleteDmMessageQueue.getJobs(['waiting', 'active', 'delayed'])
  for (const job of pendingJobs) {
    if (job.data.secretId === secretId) {
      try {
        await job.remove()
        logger.info({ jobId: job.id, secretId }, 'Cancelled pending delete job')
      } catch (err: any) {
        logger.warn({ jobId: job.id, secretId, err: err.message }, 'Failed to cancel pending delete job')
      }
    }
  }

  for (const view of views) {
    await dbs.views.markViewAsDeleted(view.id)
  }
  logger.info({ secretId, viewCount: views.length }, 'Marked all views as deleted')

  // Delete the recipient's "View Secret" DM placeholder, if one was sent
  if (secret.recipient_dm_channel_id && secret.recipient_dm_ts) {
    await deleteSlackMessage(client, secret.recipient_dm_channel_id, secret.recipient_dm_ts)
    logger.info({ secretId }, 'Deleted recipient DM placeholder message')
  }

  // Delete any open "Viewed By" message, if one exists
  if (secret.viewed_by_channel_id && secret.viewed_by_ts) {
    await deleteSlackMessage(client, secret.viewed_by_channel_id, secret.viewed_by_ts)
    logger.info({ secretId }, 'Deleted Viewed By message')
  }

  // Delete the sender's interactive placeholder message (NOT the permanent
  // announcement) - prefer the live ts/channel from an actual click over the
  // stored reference, since it's guaranteed current.
  const placeholderChannelId = placeholder?.channelId ?? secret.sender_placeholder_channel_id
  const placeholderTs = placeholder?.ts ?? secret.sender_placeholder_ts

  if (placeholderChannelId && placeholderTs) {
    await deleteSlackMessage(client, placeholderChannelId, placeholderTs)
    logger.info({ secretId, channelId: placeholderChannelId, ts: placeholderTs }, 'Deleted interactive placeholder message')
  } else {
    logger.warn({ secretId }, 'No sender placeholder reference available - cannot delete it')
  }

  // For secrets carrying a file, delete the local encrypted file
  if (secret.file_path) {
    try {
      await fs.promises.unlink(secret.file_path)
      logger.info({ secretId, filePath: secret.file_path }, 'Deleted local encrypted file')
    } catch (err: any) {
      logger.warn({ err, secretId, filePath: secret.file_path }, 'Failed to delete local encrypted file')
    }
  }

  // Hard-delete from DB
  await dbs.secrets.hardDeleteSecretsForId(secretId)
  logger.info({ secretId }, 'Secret hard-deleted from DB')
}
