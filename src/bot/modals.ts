import { WebClient } from '@slack/web-api'
import { logger } from '../utils/logger'
import { encryptSecret } from '../crypto/secret'
import { getMasterKey } from '../crypto/master'
import { getConfig } from '../config/timing'
import { buildPlaceholderBlocks, buildRecipientPlaceholderBlocks, buildPermanentAnnouncementBlocks } from '../slack/view-builder'
import { createDatabases } from '../db'
import { pool } from '../db/client'

export type ModalSubmitArgs = {
  view: {
    id: string
    callback_id: string
    state: {
      values: Record<string, Record<string, any>>
    }
  }
  ack: () => Promise<void>
  body: {
    user: { id: string }
    channel?: { id: string }
    container?: { channel_id?: string }
  }
  client: WebClient
}

export async function handleModalSubmit(args: ModalSubmitArgs): Promise<void> {
  const { view, ack, body, client } = args

  await ack()

  // Extract data from the modal state
  const values = view.state.values
  const textValue = values.text_block?.secret_text?.value

  // Try to get recipient from modal state
  const recipientFromState = (values.recipient_block?.recipient as any)?.selected_user

  logger.info({ recipientFromState }, 'Extracted recipient from modal')

  // Use recipient from state if selected
  const recipientValue = recipientFromState || undefined

  if (!textValue || textValue.trim().length === 0) {
    logger.warn('Modal submitted with empty text')
    return
  }

  const secretText = textValue
  const senderId = body.user.id

  // Try to get the origin channel ID from various sources
  let originChannelId = (body as any).channel?.id || (body as any).container?.channel_id

  // If no channel found, try to get the user's DM channel
  if (!originChannelId) {
    try {
      const dmResult = await client.conversations.open({ users: senderId })
      originChannelId = dmResult.channel?.id || 'unknown'
    } catch (err) {
      logger.warn({ err, senderId }, 'Failed to open DM for sender')
      originChannelId = 'unknown'
    }
  }

  logger.info({ senderId, recipient: recipientValue, textLength: secretText.length, originChannelId, bodyKeys: Object.keys(body as any) }, 'Processing modal submission')

  try {
    const dbs = createDatabases(pool)

    // Determine visibility mode and recipient
    const visibilityMode = recipientValue ? 'single' : 'multi'
    const allowedViewerId = recipientValue || null

    // Encrypt the secret
    const masterKey = await getMasterKey()
    const envelope = await encryptSecret(secretText, masterKey)

    // Calculate expiry using config
    const config = getConfig()
    const expiresAt = new Date(Date.now() + config.timing.secret_expiry_ms)

    // Create the secret in the database
    const secret = await dbs.secrets.createSecret({
      senderId,
      originChannelId,
      originTs: '', // Will be updated after placeholder is posted
      type: 'text',
      ciphertext: Buffer.from(envelope.ciphertext, 'base64'),
      iv: Buffer.from(envelope.nonce, 'base64'),
      encryptedDataKey: Buffer.from(envelope.encryptedDataKey, 'base64'),
      allowedViewerId,
      visibilityMode,
      expiresAt,
    })

    logger.info({ secretId: secret.id, visibilityMode, allowedViewerId }, 'Secret stored in DB')

    // Get sender name
    const senderName = await getUserName(client, senderId)
    const recipientName = recipientValue ? await getUserName(client, recipientValue) : null

    // Build placeholder blocks for SENDER (all 3 buttons)
    const placeholderBlocks = buildPlaceholderBlocks('text', senderName, recipientName, secret.id)

    // Post PERMANENT announcement message in origin channel (won't be deleted on revoke)
    const announcementBlocks = buildPermanentAnnouncementBlocks('text', senderName, recipientName)
    const announcementResult = await client.chat.postMessage({
      channel: originChannelId,
      blocks: announcementBlocks,
      text: `${senderName} sent a secret`,
      metadata: {
        event_type: 'secret_announcement',
        event_payload: {
          secret_id: secret.id,
          sender_id: senderId,
        },
      },
    })

    if (announcementResult.ok) {
      logger.info({ secretId: secret.id, announcementTs: announcementResult.ts }, 'Permanent announcement posted')
    } else {
      logger.error({ err: announcementResult.error }, 'Failed to post permanent announcement')
    }

    // Post the INTERACTIVE placeholder message (will be updated/deleted on actions)
    const postResult = await client.chat.postMessage({
      channel: originChannelId,
      blocks: placeholderBlocks,
      text: `Secret shared by ${senderName}`,
      metadata: {
        event_type: 'secret_shared',
        event_payload: {
          secret_id: secret.id,
          sender_id: senderId,
        },
      },
    })

    if (postResult.ok) {
      logger.info({ secretId: secret.id, placeholderTs: postResult.ts }, 'Interactive placeholder posted to origin channel')
    } else {
      logger.error({ err: postResult.error }, 'Failed to post interactive placeholder')
    }

    // If recipient specified, send a DM to the recipient with only the View Secret button
    if (recipientValue) {
      const dmResult = await client.conversations.open({ users: recipientValue })
      const dmChannelId = dmResult.channel?.id

      if (dmChannelId) {
        const recipientPlaceholderBlocks = buildRecipientPlaceholderBlocks('text', senderName, recipientName, secret.id)

        const dmPostResult = await client.chat.postMessage({
          channel: dmChannelId,
          blocks: recipientPlaceholderBlocks,
          text: `Secret from ${senderName}`,
        })

        if (dmPostResult.ok) {
          logger.info({ secretId: secret.id, dmChannelId }, 'Recipient DM posted')
          await dbs.secrets.setRecipientDmMessage(secret.id, dmChannelId, dmPostResult.ts!)
        } else {
          logger.error({ err: dmPostResult.error }, 'Failed to post recipient DM')
        }
      } else {
        logger.warn({ recipientId: recipientValue }, 'Failed to open DM channel')
      }
    }
  } catch (err: any) {
    logger.error({ err, errMessage: err.message, errStack: err.stack }, 'Error processing modal submission')
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
