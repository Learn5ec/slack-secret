import { WebClient } from '@slack/web-api'
import { logger } from '../utils/logger'
import { decryptSecret } from '../crypto/secret'
import { getMasterKey } from '../crypto/master'
import { createDatabases } from '../db'
import { pool } from '../db/client'
import { buildViewedByBlocks, buildRevealedSecretBlocks } from '../slack/view-builder'
import { deleteSlackMessage } from '../slack/messages'
import { deleteDmMessageQueue } from '../queue/client'
import { getConfig } from '../config/timing'
import { markdownToSlackBlocks } from '../markdown/converter'
import { formatIST } from '../utils/time'

type ActionBody = {
  user: { id: string }
  channel?: { id: string }
  message?: {
    ts: string
    metadata?: {
      event_payload?: {
        secret_id: string
        sender_id: string
      }
    }
  }
  event?: {
    user?: string
  }
}

type ActionArgs = {
  action: { value: string }
  ack: () => Promise<void>
  body: ActionBody
  client: WebClient
  respond?: (response: any) => Promise<any>
}

export async function handleViewAction(args: ActionArgs): Promise<void> {
  const { action, ack, body, client } = args

  const secretId = action.value
  const userId = body.user.id

  logger.info({ secretId, userId }, 'View action triggered')

  await ack()

  try {
    const dbs = createDatabases(pool)

    // Get the secret from DB
    const secret = await dbs.secrets.getSecretById(secretId)
    if (!secret) {
      logger.warn({ secretId }, 'Secret not found')
      return
    }

    if (secret.status === 'expired') {
      logger.info({ secretId, userId }, 'Secret already expired')
      await notifyViewer(client, body, userId, '🔒 Secret Expired')
      return
    }

    // Check if this is the sender
    if (userId === secret.sender_id) {
      // Sender self-view: decrypt and DM the sender
      await handleViewFlow({
        secret,
        viewerId: secret.sender_id,
        client,
        body,
        dbs,
        headerText: '*Your Secret:*',
        postText: 'Your Secret',
      })
      return
    }

    // Recipient view flow
    await handleRecipientView(secret, userId, client, dbs, body)
  } catch (err: any) {
    logger.error({ err, secretId, userId }, 'Error in view action')
  }
}

async function handleRecipientView(secret: any, viewerId: string, client: WebClient, dbs: any, body: ActionBody): Promise<void> {
  logger.info({ secretId: secret.id, viewerId }, 'Recipient view flow')

  // Check if secret is still available
  if (secret.status === 'expired' || secret.status === 'cancelled') {
    logger.info({ secretId: secret.id }, 'Secret no longer available')
    return
  }

  // Check if this viewer is allowed (for single-mode)
  if (secret.visibility_mode === 'single' && secret.allowed_viewer_id && secret.allowed_viewer_id !== viewerId) {
    logger.warn({ secretId: secret.id, viewerId }, 'Viewer not allowed')
    return
  }

  const senderName = await getUserName(client, secret.sender_id)
  await handleViewFlow({
    secret,
    viewerId,
    client,
    body,
    dbs,
    headerText: `*Secret from ${senderName}:*`,
    postText: `Secret from ${senderName}`,
  })
}

// Shared by sender self-view and recipient view. Each viewer gets their own
// independent one-time view (view-once is per-viewer, not global to the
// secret). If the viewer hid the message earlier, re-clicking View Secret
// re-opens it as long as we're still within the ORIGINAL delete_at window
// (the window is fixed at first view, not extended by hiding/re-opening);
// once that window has passed, it shows "Secret Expired" instead.
async function handleViewFlow(params: {
  secret: any
  viewerId: string
  client: WebClient
  body: ActionBody
  dbs: any
  headerText: string
  postText: string
}): Promise<void> {
  const { secret, viewerId, client, body, dbs, headerText, postText } = params

  try {
    const existing = await dbs.views.getView(secret.id, viewerId)
    const now = Date.now()

    if (existing && existing.status === 'delivered') {
      logger.info({ secretId: secret.id, viewerId }, 'Secret already open for viewer')
      await notifyViewer(client, body, viewerId, 'Your secret is already open - check your messages.')
      return
    }

    if (existing && existing.status === 'deleted') {
      const deleteAt = existing.delete_at ? new Date(existing.delete_at).getTime() : 0
      if (now >= deleteAt) {
        logger.info({ secretId: secret.id, viewerId }, 'View window has expired')
        await notifyViewer(client, body, viewerId, '🔒 Secret Expired')
        return
      }
    }

    // Open DM with viewer
    const dmResult = await client.conversations.open({ users: viewerId })
    const dmChannelId = dmResult.channel?.id

    if (!dmChannelId) {
      logger.error({ secretId: secret.id, viewerId }, 'Failed to open DM')
      return
    }

    // Decrypt using proper envelope
    const envelope = {
      version: 1 as const,
      algorithm: 'xsalsa20poly1305' as const,
      nonce: Buffer.from(secret.iv).toString('base64'),
      ciphertext: Buffer.from(secret.ciphertext).toString('base64'),
      encryptedDataKey: secret.encrypted_data_key ? Buffer.from(secret.encrypted_data_key).toString('base64') : '',
    }

    const plaintext = await decryptSecret(envelope, await getMasterKey())
    const secretBlocks = markdownToSlackBlocks(plaintext)
    const blocks = buildRevealedSecretBlocks(headerText, secretBlocks, secret.id)

    const postResult = await client.chat.postMessage({
      channel: dmChannelId,
      text: postText,
      blocks,
    })

    if (!postResult.ok || !postResult.ts) {
      logger.warn({ secretId: secret.id, viewerId, err: postResult.error }, 'Failed to send secret DM')
      return
    }

    if (existing) {
      // Re-open within the original window - delete_at stays fixed from first view
      await dbs.views.reopenView(existing.id, dmChannelId, postResult.ts)

      const deleteAt = new Date(existing.delete_at)
      const remainingMs = Math.max(1000, deleteAt.getTime() - now)

      // Schedule auto-deletion for whatever's left of the original window - the
      // exact same function that the embedded Hide Secret button and Revoke call.
      await deleteDmMessageQueue.add(
        'delete-revealed-secret',
        { viewId: existing.id, secretId: secret.id },
        { delay: remainingMs },
      )

      logger.info({ secretId: secret.id, viewerId, viewId: existing.id, remainingMs }, 'Secret re-opened within original window')
      return
    }

    const config = getConfig()
    const deleteAt = new Date(now + config.timing.delete_after_view_ms)

    const result = await dbs.views.createDeliveredView({
      secretId: secret.id,
      viewerId,
      dmChannelId,
      dmTs: postResult.ts,
      deleteAt,
    })

    if (!result.created) {
      // Lost a race with a concurrent click on the same button - clean up the duplicate post
      logger.info({ secretId: secret.id, viewerId }, 'Lost race on view creation, removing duplicate post')
      await deleteSlackMessage(client, dmChannelId, postResult.ts)
      return
    }

    // Schedule auto-deletion using config - the exact same function that the
    // embedded Hide Secret button and Revoke call.
    await deleteDmMessageQueue.add(
      'delete-revealed-secret',
      { viewId: result.view!.id, secretId: secret.id },
      { delay: config.timing.delete_after_view_ms },
    )

    logger.info({ secretId: secret.id, viewerId, viewId: result.view!.id, deleteAfterMs: config.timing.delete_after_view_ms }, 'Secret delivered to viewer, scheduled auto-delete')
  } catch (err: any) {
    logger.error({ err, secretId: secret.id, viewerId }, 'Error in view flow')
  }
}

async function notifyViewer(client: WebClient, body: ActionBody, viewerId: string, text: string): Promise<void> {
  const channelId = body.channel?.id || (body as any).channel_id
  if (!channelId) {
    logger.warn({ viewerId }, 'No channel ID available to notify viewer')
    return
  }
  try {
    await client.chat.postEphemeral({
      channel: channelId,
      user: viewerId,
      text,
    })
  } catch (err: any) {
    logger.warn({ err, viewerId }, 'Failed to notify viewer')
  }
}

export async function handleViewedByAction(args: ActionArgs): Promise<void> {
  const { action, ack, body, client } = args

  const secretId = action.value
  const userId = body.user.id

  logger.info({ secretId, userId, bodyKeys: Object.keys(body as any) }, 'Viewed By action triggered')

  await ack()

  try {
    const dbs = createDatabases(pool)
    const secret = await dbs.secrets.getSecretById(secretId)

    if (!secret) {
      logger.warn({ secretId }, 'Secret not found')
      return
    }

    // Only sender can view this
    if (userId !== secret.sender_id) {
      logger.warn({ userId, secretId }, 'Non-sender attempted Viewed By')
      return
    }

    // Get all views for this secret
    const views = await dbs.views.getViewsBySecretId(secretId)

    // Build viewer list
    const viewerList = await Promise.all(
      views.map(async (view: any) => {
        const name = await getUserName(client, view.viewer_id)
        const deliveredAt = view.delivered_at
          ? formatIST(new Date(view.delivered_at))
          : 'Unknown'
        return { name, deliveredAt }
      }),
    )

    // If sender already has a Viewed By message open, remove it first so
    // repeated clicks don't pile up duplicates - and so Revoke always has at
    // most one to clean up.
    if (secret.viewed_by_channel_id && secret.viewed_by_ts) {
      await deleteSlackMessage(client, secret.viewed_by_channel_id, secret.viewed_by_ts)
    }

    // Send via a real DM (like the secret reveal) rather than a true Slack
    // ephemeral, so it has a stable channel/ts that Revoke can delete later.
    try {
      const dmResult = await client.conversations.open({ users: userId })
      const dmChannelId = dmResult.channel?.id

      if (!dmChannelId) {
        throw new Error('Failed to open DM for Viewed By')
      }

      const postResult = await client.chat.postMessage({
        channel: dmChannelId,
        text: 'Viewed By',
        blocks: buildViewedByBlocks(viewerList),
      })

      if (!postResult.ok || !postResult.ts) {
        throw new Error(postResult.error || 'chat.postMessage failed')
      }

      await dbs.secrets.setViewedByMessage(secretId, dmChannelId, postResult.ts)
      logger.info({ secretId, viewerCount: views.length }, 'Viewed By list sent to sender')
    } catch (err: any) {
      logger.warn({ err, secretId }, 'Failed to DM Viewed By list, falling back to ephemeral')
      // Fallback: a true ephemeral still gets the info in front of the sender,
      // it just won't be cleaned up by Revoke.
      const channelId = body.channel?.id || (body as any).channel_id || (body as any).container?.channel_id
      if (channelId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: 'Viewed By',
          blocks: buildViewedByBlocks(viewerList),
        })
      } else if (args.respond) {
        await args.respond({
          text: 'Viewed By',
          blocks: buildViewedByBlocks(viewerList),
          response_in_channel: false,
        })
      }
    }
  } catch (err: any) {
    logger.error({ err, secretId, userId }, 'Error in Viewed By action')
  }
}

export async function handleCancelAction(args: ActionArgs): Promise<void> {
  const { action, ack, body, client } = args

  const secretId = action.value
  const userId = body.user.id

  logger.info({ secretId, userId }, 'Cancel action triggered')

  await ack()

  try {
    const dbs = createDatabases(pool)
    const secret = await dbs.secrets.getSecretById(secretId)

    if (!secret) {
      logger.warn({ secretId }, 'Secret not found')
      return
    }

    // Only sender can cancel
    if (userId !== secret.sender_id) {
      logger.warn({ userId, secretId }, 'Non-sender attempted Cancel')
      return
    }

    // Get all delivered views and delete any already-revealed secret messages
    // (same shared deleteSlackMessage function the timer job and Hide button use)
    const views = await dbs.views.getDeliveredViewsForSecret(secretId)
    logger.info({ secretId, viewCount: views.length }, 'Found views for cancel')

    for (const view of views) {
      if (view.dm_channel_id && view.dm_ts) {
        await deleteSlackMessage(client, view.dm_channel_id, view.dm_ts)
        logger.info({ viewId: view.id }, 'Deleted revealed-secret message')
      } else {
        logger.warn({ viewId: view.id }, 'View has no dm_channel_id/dm_ts, cannot delete message')
      }
    }

    // Cancel any pending delete jobs for this secret
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

    // Mark all views as deleted
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

    // Delete the sender's interactive placeholder message (NOT the permanent announcement)
    const messageTs = body.message?.ts || (body as any).message_ts
    const channelId = body.channel?.id || (body as any).channel_id

    if (messageTs && channelId) {
      await deleteSlackMessage(client, channelId, messageTs)
      logger.info({ secretId, channelId, messageTs }, 'Deleted interactive placeholder message')
    } else {
      logger.warn({ secretId, hasMessageTs: !!messageTs, hasChannelId: !!channelId }, 'Cannot delete placeholder - missing message ts or channel id')
    }

    // Hard-delete from DB
    await dbs.secrets.hardDeleteSecretsForId(secretId)
    logger.info({ secretId }, 'Secret hard-deleted from DB')
  } catch (err: any) {
    logger.error({ err, secretId, userId }, 'Error in Cancel action')
  }
}

export async function handleHideAction(args: ActionArgs): Promise<void> {
  const { action, ack, body, client } = args

  const secretId = action.value
  const userId = body.user.id

  logger.info({ secretId, userId }, 'Hide action triggered')

  await ack()

  try {
    const dbs = createDatabases(pool)

    const views = await dbs.views.getViewsBySecretId(secretId)
    const userView = views.find((v: any) => v.viewer_id === userId && v.status === 'delivered')

    if (!userView) {
      logger.info({ secretId, userId }, 'No delivered view found for user, nothing to hide')
      return
    }

    if (userView.dm_channel_id && userView.dm_ts) {
      await deleteSlackMessage(client, userView.dm_channel_id, userView.dm_ts)
    } else {
      logger.warn({ secretId, userId, viewId: userView.id }, 'View has no dm_channel_id/dm_ts, cannot delete message')
    }

    await dbs.views.markViewAsDeleted(userView.id)

    // Cancel this view's pending auto-delete job so it doesn't fire redundantly later
    const pendingJobs = await deleteDmMessageQueue.getJobs(['waiting', 'active', 'delayed'])
    for (const job of pendingJobs) {
      if (job.data.viewId === userView.id) {
        try {
          await job.remove()
          logger.info({ jobId: job.id, viewId: userView.id }, 'Cancelled pending delete job on hide')
        } catch (err: any) {
          logger.warn({ jobId: job.id, viewId: userView.id, err: err.message }, 'Failed to cancel pending delete job on hide')
        }
      }
    }

    logger.info({ secretId, userId, viewId: userView.id }, 'Secret hidden successfully')
  } catch (err: any) {
    logger.error({ err, secretId, userId }, 'Error in Hide action')
  }
}

async function getUserName(client: WebClient, userId: string): Promise<string> {
  try {
    const result = await client.users.info({ user: userId })
    return result.user?.name || userId
  } catch {
    return userId
  }
}
