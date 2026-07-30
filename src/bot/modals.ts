import { WebClient } from '@slack/web-api'
import { logger } from '../utils/logger'
import { encryptSecret, encryptFile } from '../crypto/secret'
import { getMasterKey } from '../crypto/master'
import { getConfig } from '../config/timing'
import { buildPlaceholderBlocks, buildRecipientPlaceholderBlocks, buildPermanentAnnouncementBlocks } from '../slack/view-builder'
import { createDatabases } from '../db'
import { pool } from '../db/client'
import { readLocalFile, writeLocalFile, getStorageDir, generateFilePath } from '../utils/file-ops'
import { scanFile } from '../utils/av-scanner'
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
  logger.debug({ values }, 'Full modal state values')

  const textValue = values.text_block?.secret_text?.value
  // Slack's file_input state value is an OBJECT ({ type: 'file_input', files: [...] }),
  // not an array itself - the uploaded files live under its `.files` property.
  const fileValue = values.file_block?.file_input?.files as any[] | undefined

  logger.info({ fileValue, textValue, hasTextBlock: !!values.text_block, hasFileBlock: !!values.file_block }, 'Extracted file and text from modal')

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

  // Try to get recipient from modal state
  const recipientFromState = (values.recipient_block?.recipient as any)?.selected_user
  const recipientValue = recipientFromState || undefined

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

  logger.info({ senderId, recipient: recipientValue, hasText, hasFile, textLength: secretText?.length, originChannelId }, 'Processing modal submission')

  try {
    const dbs = createDatabases(pool)

    // Determine visibility mode and recipient
    const visibilityMode = recipientValue ? 'single' : 'multi'
    const allowedViewerId = recipientValue || null

    // Get sender name
    const senderName = await getUserName(client, senderId)
    const recipientName = recipientValue ? await getUserName(client, recipientValue) : null

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

    // Build placeholder blocks
    const placeholderBlocks = buildPlaceholderBlocks(secretType, senderName, recipientName, secret.id)

    // Post PERMANENT announcement message
    const announcementBlocks = buildPermanentAnnouncementBlocks(secretType, senderName, recipientName)
    const announcementResult = await client.chat.postMessage({
      channel: originChannelId,
      blocks: announcementBlocks,
      text: `${senderName} sent a ${secretType === 'text' ? 'secret' : secretType === 'file' ? 'file' : 'secret with file'}`,
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

    // Post the INTERACTIVE placeholder message
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

    if (postResult.ok && postResult.ts) {
      logger.info({ secretId: secret.id, placeholderTs: postResult.ts }, 'Interactive placeholder posted to origin channel')
      await dbs.secrets.setSenderPlaceholderMessage(secret.id, originChannelId, postResult.ts)
    } else {
      logger.error({ err: postResult.error }, 'Failed to post interactive placeholder')
    }

    // If recipient specified, send a DM to the recipient
    if (recipientValue) {
      const dmResult = await client.conversations.open({ users: recipientValue })
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
