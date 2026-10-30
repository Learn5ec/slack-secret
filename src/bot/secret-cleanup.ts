import { WebClient } from '@slack/web-api'
import fs from 'fs'
import { logger } from '../utils/logger'
import { deleteSlackMessage, deleteSlackFile } from '../slack/messages'
import { deleteDmMessageQueue } from '../queue/client'
import { buildRevokedChannelAnnouncementBlocks, buildExpiredChannelAnnouncementBlocks } from '../slack/view-builder'

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
  reason: 'revoked' | 'expired' = 'expired',
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

  // Delete channel member DM placeholders (View Secret buttons sent before anyone clicked)
  const channelDms = await dbs.channelMemberDms.getBySecretId(secretId)
  for (const channelDm of channelDms) {
    if (channelDm.dm_ts) {
      await deleteSlackMessage(client, channelDm.dm_channel_id, channelDm.dm_ts)
    }
  }
  logger.info({ secretId, channelDmCount: channelDms.length }, 'Deleted channel member DM placeholders')

  // Update channel announcement in-place (if any)
  if (secret.channel_announcement_channel_id && secret.channel_announcement_ts) {
    try {
      const channelInfo = await client.conversations.info({
        channel: secret.channel_announcement_channel_id,
      })
      // An mpim's real name is an "mpdm-…" slug; show "this group conversation"
      // instead of "#mpdm-…". Only channels with a real name get "#name".
      const isMpim = (channelInfo.channel as any)?.is_mpim === true
      const channelName = isMpim ? null : ((channelInfo.channel as any)?.name ?? null)
      const label = isMpim ? 'group conversation' : 'channel'
      const senderName = `<@${secret.sender_id}>`

      const blocks = reason === 'revoked'
        ? buildRevokedChannelAnnouncementBlocks(senderName, channelName, label)
        : buildExpiredChannelAnnouncementBlocks(
            senderName,
            channelName,
            new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
            label,
          )

      await client.chat.update({
        channel: secret.channel_announcement_channel_id,
        ts: secret.channel_announcement_ts,
        blocks,
        text: reason === 'revoked'
          ? `${senderName} revoked a secret.`
          : `${senderName}'s secret expired.`,
      })
      logger.info({ secretId, channelId: secret.channel_announcement_channel_id, ts: secret.channel_announcement_ts }, 'Channel announcement updated in-place')
    } catch (err: any) {
      logger.error({ err, secretId }, 'Failed to update channel announcement')
    }
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

// Remove ONE viewer's access to an otherwise-live secret: their placeholder DM,
// any revealed copy, the delete-timer job, and the allow-list grant. Touches
// ONLY that viewer — every other recipient (and the secret itself) is left
// intact. This is the per-recipient slice of purgeSecret; each person's access
// is an individual (secret_id, viewer_id) row, so removal has no blast radius.
export async function removeViewerAccess(
  client: WebClient,
  dbs: any,
  secret: any,
  viewerId: string,
): Promise<void> {
  const secretId = secret.id

  // 1) Their revealed copy (per-viewer view-once message + file), if any.
  const view = await dbs.views.getView(secretId, viewerId)
  if (view && view.status === 'delivered') {
    if (view.dm_channel_id) {
      if (view.dm_ts) await deleteSlackMessage(client, view.dm_channel_id, view.dm_ts)
      if (view.file_upload_id) await deleteSlackFile(client, view.file_upload_id)
      if (view.file_dm_ts) await deleteSlackMessage(client, view.dm_channel_id, view.file_dm_ts)
    }
    // Cancel just this view's pending auto-delete job.
    const pendingJobs = await deleteDmMessageQueue.getJobs(['waiting', 'active', 'delayed'])
    for (const job of pendingJobs) {
      if (job.data.viewId === view.id) {
        try {
          await job.remove()
        } catch (err: any) {
          logger.warn({ jobId: job.id, viewId: view.id, err: err.message }, 'Failed to cancel delete job on remove')
        }
      }
    }
    await dbs.views.markViewAsDeleted(view.id)
    logger.info({ secretId, viewerId, viewId: view.id }, 'Removed viewer revealed copy')
  }

  // 2) Their un-opened "View Secret" placeholder DM (fan-out member / forward).
  const channelDm = await dbs.channelMemberDms.getBySecretAndMember(secretId, viewerId)
  if (channelDm) {
    if (channelDm.dm_ts) await deleteSlackMessage(client, channelDm.dm_channel_id, channelDm.dm_ts)
    await dbs.channelMemberDms.deleteBySecretAndMember(secretId, viewerId)
    logger.info({ secretId, viewerId }, 'Removed viewer placeholder DM (channel_member_dms)')
  }

  // 3) If they were the original 1:1 recipient, remove that placeholder too.
  if (
    secret.allowed_viewer_id === viewerId &&
    secret.recipient_dm_channel_id &&
    secret.recipient_dm_ts
  ) {
    await deleteSlackMessage(client, secret.recipient_dm_channel_id, secret.recipient_dm_ts)
    await dbs.secrets.clearRecipientDmMessage(secretId)
    logger.info({ secretId, viewerId }, 'Removed original recipient DM placeholder')
  }

  // 4) Drop the explicit forward grant so they fail the single-mode reveal check.
  await dbs.allowedViewers.deleteBySecretAndViewer(secretId, viewerId)

  logger.info({ secretId, viewerId }, 'Viewer access removed')
}
