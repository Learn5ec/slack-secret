import { WebClient } from '@slack/web-api'
import { logger } from '../utils/logger'
import { decryptSecret, decryptFile } from '../crypto/secret'
import { getMasterKey } from '../crypto/master'
import { createDatabases } from '../db'
import { pool } from '../db/client'
import { buildViewedByBlocks, buildRevealedSecretBlocks, buildRevokeConfirmationModal } from '../slack/view-builder'
import { deleteSlackMessage, deleteSlackFile } from '../slack/messages'
import { deleteDmMessageQueue } from '../queue/client'
import { getConfig } from '../config/timing'
import { markdownToSlackBlocks } from '../markdown/converter'
import { formatIST } from '../utils/time'
import { readLocalFile } from '../utils/file-ops'
import { purgeSecret } from './secret-cleanup'

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
  trigger_id?: string
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

  const senderName = `<@${secret.sender_id}>`
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

    const masterKey = await getMasterKey()

    // Text and file are independent - a 'combined' secret delivers BOTH as
    // separate messages in the same DM, tracked as dm_ts (text) / file_dm_ts
    // (file) on one view row so either can be deleted on its own.
    let textTs: string | undefined
    let fileTs: string | undefined
    let fileUploadId: string | undefined

    if (secret.ciphertext) {
      const envelope = {
        version: 1 as const,
        algorithm: 'xsalsa20poly1305' as const,
        nonce: Buffer.from(secret.iv).toString('base64'),
        ciphertext: Buffer.from(secret.ciphertext).toString('base64'),
        encryptedDataKey: secret.encrypted_data_key ? Buffer.from(secret.encrypted_data_key).toString('base64') : '',
      }

      const plaintext = await decryptSecret(envelope, masterKey)
      const secretBlocks = markdownToSlackBlocks(plaintext)
      const blocks = buildRevealedSecretBlocks(headerText, secretBlocks, secret.id)

      const textResult = await client.chat.postMessage({
        channel: dmChannelId,
        text: postText,
        blocks,
      })

      if (textResult.ok && textResult.ts) {
        textTs = textResult.ts
      } else {
        logger.warn({ secretId: secret.id, viewerId, err: textResult.error }, 'Failed to send secret text DM')
      }
    }

    if (secret.file_path) {
      const fileBuffer = await readLocalFile(secret.file_path)
      const fileEnvelope = {
        version: 1 as const,
        algorithm: 'xsalsa20poly1305' as const,
        nonce: Buffer.from(secret.file_iv).toString('base64'),
        ciphertext: fileBuffer.toString('base64'),
        encryptedDataKey: secret.file_encrypted_data_key ? Buffer.from(secret.file_encrypted_data_key).toString('base64') : '',
      }

      const decryptedFile = await decryptFile(fileEnvelope, masterKey)

      const uploadResult: any = await client.files.uploadV2({
        channel_id: dmChannelId,
        file: decryptedFile,
        filename: secret.file_name || 'file',
        title: secret.file_name || 'file',
      })

      if (uploadResult.ok) {
        // files.uploadV2 wraps files.completeUploadExternal, whose result is
        // double-nested (uploadResult.files[0].files[0] is the actual file
        // object). The message ts for a shared file lives on that file
        // object's `shares.private`/`shares.public`, keyed by channel id -
        // there is no top-level ts on the uploadV2 result itself.
        const innerFile = uploadResult.files?.[0]?.files?.[0]
        const shareEntry = innerFile?.shares?.private?.[dmChannelId]?.[0] || innerFile?.shares?.public?.[dmChannelId]?.[0]
        fileTs = shareEntry?.ts
        fileUploadId = innerFile?.id

        if (!fileTs) {
          logger.warn({ secretId: secret.id, viewerId, innerFile }, 'File uploaded but no message ts could be found - it cannot be auto-deleted')
        }
      } else {
        logger.warn({ secretId: secret.id, viewerId, err: uploadResult.error }, 'Failed to upload secret file')
      }
    }

    // files.uploadV2 has no way to attach interactive blocks to the file-share
    // message itself, so a file-only secret would otherwise have no Hide
    // Secret button anywhere. Send a small companion message carrying just
    // that button (reusing the same dm_ts/text-message tracking, so Hide/
    // Revoke/the auto-delete timer all pick it up with no extra plumbing).
    // Not needed when there's also text content - that message already has
    // its own embedded Hide button covering the whole view.
    if (secret.file_path && !secret.ciphertext) {
      const companionBlocks = buildRevealedSecretBlocks(`${headerText}\nYour file is ready above.`, [], secret.id)
      const companionResult = await client.chat.postMessage({
        channel: dmChannelId,
        text: postText,
        blocks: companionBlocks,
      })

      if (companionResult.ok && companionResult.ts) {
        textTs = companionResult.ts
      } else {
        logger.warn({ secretId: secret.id, viewerId, err: companionResult.error }, 'Failed to send Hide Secret companion message')
      }
    }

    if (!textTs && !fileTs) {
      logger.warn({ secretId: secret.id, viewerId }, 'Nothing was successfully delivered')
      return
    }

    if (existing) {
      // Re-open within the original window - delete_at stays fixed from first view.
      // Keep whichever message ts wasn't re-delivered this time (e.g. only the
      // text half failed to resend) rather than clobbering it with null.
      await dbs.views.reopenView(
        existing.id,
        dmChannelId,
        textTs ?? existing.dm_ts,
        fileTs ?? existing.file_dm_ts,
        fileUploadId ?? existing.file_upload_id,
      )

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
      dmTs: textTs ?? null,
      fileDmTs: fileTs ?? null,
      fileUploadId: fileUploadId ?? null,
      deleteAt,
    })

    if (!result.created) {
      // Lost a race with a concurrent click on the same button - clean up the duplicate post(s)
      logger.info({ secretId: secret.id, viewerId }, 'Lost race on view creation, removing duplicate post(s)')
      if (textTs) await deleteSlackMessage(client, dmChannelId, textTs)
      if (fileUploadId) await deleteSlackFile(client, fileUploadId)
      if (fileTs) await deleteSlackMessage(client, dmChannelId, fileTs)
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
    const viewerList = views.map((view: any) => {
      const name = `<@${view.viewer_id}>`
      const deliveredAt = view.delivered_at
        ? formatIST(new Date(view.delivered_at))
        : 'Unknown'
      return { name, deliveredAt }
    })

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

  try {
    const dbs = createDatabases(pool)
    const secret = await dbs.secrets.getSecretById(secretId)

    if (!secret) {
      logger.warn({ secretId }, 'Secret not found')
      await notifyViewer(client, body, userId, '🔒 Secret not found.')
      await ack()
      return
    }

    // Only sender can cancel - check before opening the modal
    if (userId !== secret.sender_id) {
      logger.warn({ userId, secretId }, 'Non-sender attempted Cancel')
      await notifyViewer(client, body, userId, '🔒 Only the sender can revoke this secret.')
      await ack()
      return
    }

    // Always ack first to satisfy Slack's interaction response deadline
    await ack()

    // Open a confirmation modal instead of immediately revoking
    try {
      await client.views.open({
        trigger_id: args.trigger_id!,
        view: buildRevokeConfirmationModal(secretId) as any,
      })
    } catch (err: any) {
      logger.error({ err, secretId, userId }, 'Failed to open revoke confirmation modal')
    }
  } catch (err: any) {
    logger.error({ err, secretId, userId }, 'Unexpected error in cancel action')
  }
}

export async function handleRevokeConfirm(args: {
  secretId: string
  userId: string
  trigger_id: string
  client: WebClient
}): Promise<void> {
  const { secretId, userId, client } = args

  logger.info({ secretId, userId }, 'Revoke confirm: processing')

  try {
    const dbs = createDatabases(pool)
    const secret = await dbs.secrets.getSecretById(secretId)

    if (!secret) {
      logger.warn({ secretId }, 'Secret not found on confirm')
      return
    }

    // Double-check: only sender can revoke
    if (userId !== secret.sender_id) {
      logger.warn({ userId, secretId }, 'Non-sender attempted to confirm revoke')
      return
    }

    // Open DM with sender and post a "Processing..." message so they see
    // something happening while purgeSecret works in the background.
    const dmResult = await client.conversations.open({ users: userId })
    const dmChannelId = dmResult.channel?.id

    if (!dmChannelId) {
      logger.error({ secretId, userId }, 'Failed to open DM for revoke confirmation')
      return
    }

    const postResult = await client.chat.postMessage({
      channel: dmChannelId,
      text: 'Revoking...',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '⏳ *Revoking secret...* This may take a moment.',
          },
        },
      ],
    })

    if (postResult.ok && postResult.ts) {
      try {
        // Don't pass this "Processing..." message as the placeholder - that
        // would make purgeSecret delete it instead of the real interactive
        // placeholder (secret.sender_placeholder_channel_id/ts). Delete it
        // separately once purging is done.
        await purgeSecret(client, dbs, secret, 'revoked')
      } catch (err: any) {
        logger.error({ err, secretId }, 'Error during revocation')
      } finally {
        await deleteSlackMessage(client, dmChannelId, postResult.ts)
      }
    } else {
      logger.warn({ secretId, err: postResult.error }, 'Failed to post processing message')
    }
  } catch (err: any) {
    logger.error({ err, secretId, userId }, 'Error in revoke confirm flow')
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

    if (!userView.dm_channel_id) {
      logger.warn({ secretId, userId, viewId: userView.id }, 'View has no dm_channel_id, cannot delete message(s)')
    } else {
      if (userView.dm_ts) {
        await deleteSlackMessage(client, userView.dm_channel_id, userView.dm_ts)
      }
      if (userView.file_upload_id) {
        // Purge the actual file object first - re-opening later (if within
        // the original window) re-uploads a fresh copy from our own storage.
        await deleteSlackFile(client, userView.file_upload_id)
      }
      if (userView.file_dm_ts) {
        await deleteSlackMessage(client, userView.dm_channel_id, userView.file_dm_ts)
      }
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
