import { WebClient } from '@slack/web-api'
import { logger } from '../utils/logger'
import { encryptSecret, encryptFile } from '../crypto/secret'
import { getMasterKey } from '../crypto/master'
import { getConfig } from '../config/timing'
import { buildPlaceholderBlocks, buildRecipientPlaceholderBlocks, buildChannelAnnouncementBlocks } from '../slack/view-builder'
import { createDatabases } from '../db'
import { pool } from '../db/client'
import { readLocalFile, writeLocalFile, getStorageDir, generateFilePath } from '../utils/file-ops'
import { scanFile } from '../utils/av-scanner'
import { channelDeliveryQueue } from '../queue/client'
import axios from 'axios'
import fs from 'fs'
import path from 'path'

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
  // NOTE: Do NOT log modal values here — they contain the raw secret text and file URLs.
  const textValue = values.text_block?.secret_text?.value
  // Slack's file_input state value is an OBJECT ({ type: 'file_input', files: [...] }),
  // not an array itself - the uploaded files live under its `.files` property.
  const fileValue = values.file_block?.file_input?.files as any[] | undefined

  // Determine what we have
  const hasText = !!textValue && textValue.trim().length > 0
  const hasFile = !!fileValue && fileValue.length > 0

  // If both, create a combined secret (text + file)
  // If only text, create text secret
  // If only file, create file secret
  // If neither, reject
  if (!hasText && !hasFile) {
    logger.warn('Modal submitted with empty text and no file')
    return
  }

  // If file is present, validate size
  if (hasFile) {
    const file = fileValue![0]
    const fileSize = file.size || 0
    const config = getConfig()
    const maxSize = config.security.max_file_size_bytes

    if (fileSize > maxSize) {
      logger.warn({ fileSize, maxSize }, 'File exceeds size limit')
      // In a real app, we'd respond with response_action: "errors"
      return
    }
  }

  const secretText = hasText ? textValue : null
  const senderId = body.user.id

  // Try to get recipient from modal state.
  // conversations_select returns selected_conversation as a plain string ID:
  // C... = public channel, G... = private channel/group, D... = DM, U... = user.
  const selectedConv: string | null =
    (values.recipient_block?.recipient as any)?.selected_conversation ?? null

  if (!selectedConv) {
    logger.warn('Modal submitted without recipient')
    return
  }

  // Determine type by ID prefix
  const isChannelRecipient =
    selectedConv.startsWith('C') || selectedConv.startsWith('G')

  let channelRecipientId: string | null = null
  let dmUserId: string | null = null
  let visibilityMode: 'single' | 'multi'

  if (isChannelRecipient) {
    visibilityMode = 'multi'
    channelRecipientId = selectedConv
  } else {
    visibilityMode = 'single'
    // selectedConv is a DM conversation ID (D...) or User ID (U...)
    if (selectedConv.startsWith('U')) {
      dmUserId = selectedConv
    } else {
      // D... DM conversation — resolve member
      const convInfo = await client.conversations.info({ channel: selectedConv })
      const members: string[] = (convInfo.channel as any)?.members || []
      dmUserId = members.find((m: string) => m !== senderId) ?? null
      if (!dmUserId) {
        logger.error({ selectedConv }, 'Could not resolve DM recipient')
        return
      }
    }
  }

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

  logger.info({ senderId, recipient: dmUserId || channelRecipientId, hasText, hasFile, textLength: secretText?.length, originChannelId }, 'Processing modal submission')

  try {
    const dbs = createDatabases(pool)

    // Determine visibility mode and allowed viewer
    // For channel secrets: visibility_mode='multi', allowedViewerId=null
    // For 1:1: visibility_mode='single', allowedViewerId=dmUserId
    const visibilityMode = isChannelRecipient ? 'multi' : 'single'
    const allowedViewerId = isChannelRecipient ? null : dmUserId

    // Get sender name
    const senderName = `<@${senderId}>`
    const recipientName = dmUserId ? `<@${dmUserId}>` : null

    const secretType: 'text' | 'file' | 'combined' = hasText && hasFile ? 'combined' : hasFile ? 'file' : 'text'
    const masterKey = await getMasterKey()

    // Text and file are encrypted and stored independently, so either or both
    // can be present on one secret row: text uses ciphertext/iv/encrypted_data_key,
    // the file uses its own file_iv/file_encrypted_data_key (ciphertext on disk).
    let textCiphertext: Buffer | null = null
    let textIv: Buffer | null = null
    let textEncryptedDataKey: Buffer | null = null

    if (hasText) {
      const envelope = await encryptSecret(secretText!, masterKey)
      textCiphertext = Buffer.from(envelope.ciphertext, 'base64')
      textIv = Buffer.from(envelope.nonce, 'base64')
      textEncryptedDataKey = Buffer.from(envelope.encryptedDataKey, 'base64')
    }

    let localFilePath: string | null = null
    let fileName: string | null = null
    let fileSize: number | null = null
    let fileIv: Buffer | null = null
    let fileEncryptedDataKey: Buffer | null = null

    if (hasFile) {
      const file = fileValue![0]
      fileName = file.name || 'file.bin'
      fileSize = file.size || 0

      // Download file from Slack
      logger.info({ fileName, fileSize }, 'Downloading file from Slack')
      const fileBuffer = await downloadFileFromSlack(client, file.url_private, file.url_private_download)

      // AV scan
      logger.info({ fileName }, 'Running AV scan')
      const scanResult = await scanFile(fileBuffer, fileName!)
      if (!scanResult.clean) {
        logger.error({ fileName, detected: scanResult.detected }, 'AV scan failed')
        return
      }

      // Encrypt file
      logger.info({ fileName }, 'Encrypting file')
      const envelope = await encryptFile(fileBuffer, masterKey)

      // Store encrypted file locally
      localFilePath = generateFilePath(fileName!)
      await writeLocalFile(localFilePath, Buffer.from(envelope.ciphertext, 'base64'))
      fileIv = Buffer.from(envelope.nonce, 'base64')
      fileEncryptedDataKey = Buffer.from(envelope.encryptedDataKey, 'base64')

      // Best-effort: delete the Slack-side copy. This routinely fails with
      // cant_delete_file - Slack attributes ownership of a file uploaded
      // through a modal's file_input picker to the submitting USER, not the
      // bot, and a bot token can never delete another user's file regardless
      // of scopes. Our own encrypted copy is already safely stored at this
      // point, so this must not block the rest of the sharing flow.
      logger.info({ fileName }, 'Attempting to delete Slack-side file copy')
      try {
        await client.files.delete({ file: file.id })
      } catch (err: any) {
        logger.warn({ err, fileName }, 'Could not delete Slack-side file copy (expected for user-uploaded files)')
      }
    }

    const config = getConfig()
    const expiresAt = new Date(Date.now() + config.timing.secret_expiry_ms)

    const secret = await dbs.secrets.createSecret({
      senderId,
      originChannelId,
      originTs: '',
      type: secretType,
      ciphertext: textCiphertext,
      iv: textIv,
      encryptedDataKey: textEncryptedDataKey,
      filePath: localFilePath,
      fileName,
      fileSizeBytes: fileSize,
      fileIv,
      fileEncryptedDataKey,
      allowedViewerId,
      visibilityMode,
      expiresAt,
    })

    logger.info({ secretId: secret.id, secretType, hasText, hasFile }, 'Secret stored in DB')

    // For ALL secrets (1:1 and channel) — post sender's 3-button message to sender's DM
    const senderDmResult = await client.conversations.open({ users: senderId })
    const senderDmChannelId = senderDmResult.channel?.id

    if (senderDmChannelId) {
      const placeholderBlocks = buildPlaceholderBlocks(secretType, senderName, recipientName, secret.id)
      const senderMsgResult = await client.chat.postMessage({
        channel: senderDmChannelId,
        blocks: placeholderBlocks,
        text: `You shared a secret. Use the buttons to manage it.`,
      })
      if (senderMsgResult.ok && senderMsgResult.ts) {
        await dbs.secrets.setSenderPlaceholderMessage(secret.id, senderDmChannelId, senderMsgResult.ts)
        logger.info({ secretId: secret.id, senderDmChannelId }, 'Sender placeholder posted to DM')
      }
    } else {
      logger.warn({ secretId: secret.id, senderId }, 'Could not open DM with sender for placeholder')
    }

    // Channel recipient: post announcement + async delivery
    if (isChannelRecipient && channelRecipientId) {
      // Resolve channel name for announcements
      const channelInfo = await client.conversations.info({ channel: channelRecipientId })
      const isMember = channelInfo.channel?.is_member
      const isPrivate = channelInfo.channel?.is_private
      const channelName = (channelInfo.channel as any)?.name ?? null

      if (!isMember) {
        if (!isPrivate) {
          // Public channel — bot can self-join
          await client.conversations.join({ channel: channelRecipientId })
          logger.info({ channelRecipientId }, 'Bot joined public channel')
        } else {
          // Private channel — cannot auto-join, notify sender via their DM
          logger.warn({ channelRecipientId }, 'Bot not in private channel, cannot deliver')
          if (senderDmChannelId) {
            await client.chat.postMessage({
              channel: senderDmChannelId,
              text: `⚠️ The bot is not in the private channel <#${channelRecipientId}>. Please invite @SecretBot to that channel first, then try again.`,
            })
          }
          await dbs.secrets.hardDeleteSecretsForId(secret.id)
          return
        }
      }

      // Post channel announcement (visible to all members)
      const announcementBlocks = buildChannelAnnouncementBlocks(`<@${senderId}>`, channelName)
      const announcementResult = await client.chat.postMessage({
        channel: channelRecipientId,
        blocks: announcementBlocks,
        text: `<@${senderId}> shared a secret in #${channelName ?? 'this channel'}. Check your DMs.`,
      })

      if (announcementResult.ok && announcementResult.ts) {
        await dbs.secrets.setChannelAnnouncementMessage(
          secret.id,
          channelRecipientId,
          announcementResult.ts,
        )
      }

      // Check member count against cap before enqueuing
      const memberIds = await resolveChannelMembers(client, channelRecipientId)
      const config = getConfig()
      const botUid = await getBotUserId(client)
      const memberCount = memberIds.filter((m: string) => m !== senderId && m !== botUid).length
      if (memberCount > config.security.max_channel_members) {
        logger.warn({ memberCount, cap: config.security.max_channel_members }, 'Channel too large')
        if (senderDmChannelId) {
          await client.chat.postMessage({
            channel: senderDmChannelId,
            text: `⚠️ Channel has ${memberCount} members, exceeding the cap of ${config.security.max_channel_members}. Secret not delivered.`,
          })
        }
        await dbs.secrets.hardDeleteSecretsForId(secret.id)
        return
      }

      // Enqueue async delivery — do NOT loop here (ack window constraint)
      await channelDeliveryQueue.add('deliver-channel-secret', {
        secretId: secret.id,
        channelId: channelRecipientId,
        senderId,
      })

      logger.info({ secretId: secret.id, channelRecipientId }, 'Channel secret delivery enqueued')
    } else {
      // 1:1 DM secret — recipient gets their View Secret DM (unchanged)
      if (dmUserId) {
        const dmResult = await client.conversations.open({ users: dmUserId })
        const dmChannelId = dmResult.channel?.id
        if (dmChannelId) {
          const recipientPlaceholderBlocks = buildRecipientPlaceholderBlocks(secretType, senderName, recipientName, secret.id)

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
          logger.warn({ recipientId: dmUserId }, 'Failed to open DM channel')
        }
      }
    }
  } catch (err: any) {
    logger.error({ err, errMessage: err.message, errStack: err.stack }, 'Error processing modal submission')
  }
}

async function downloadFileFromSlack(client: WebClient, urlPrivate: string, urlPrivateDownload: string): Promise<Buffer> {
  // Use the bot token to download the file
  const token = (client as any).token

  const response = await axios.get(urlPrivateDownload, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    responseType: 'arraybuffer',
  })

  return Buffer.from(response.data)
}

// Paginate conversations.members and return all member IDs (human + bot).
// Used by the modal handler to compute the deliverable member count, and by
// the channel-delivery worker to know who to DM.
async function resolveChannelMembers(client: WebClient, channelId: string): Promise<string[]> {
  const memberIds: string[] = []
  let cursor: string | undefined
  do {
    const result = await (client as any).conversations.members({
      channel: channelId,
      limit: 1000,
      cursor,
    })
    if (result.members) memberIds.push(...result.members)
    cursor = result.response_metadata?.next_cursor
  } while (cursor)
  return memberIds
}

// Resolve the bot's own user ID so we can exclude it from channel deliveries.
// Cached for the lifetime of the process.
let cachedBotUserId: string | null = null
export async function getBotUserId(client: WebClient): Promise<string | null> {
  if (cachedBotUserId) return cachedBotUserId
  try {
    const authResult = await client.auth.test()
    if (authResult.ok) cachedBotUserId = authResult.user_id as string
  } catch (err) {
    logger.error({ err }, 'Failed to resolve bot user ID')
  }
  return cachedBotUserId
}
