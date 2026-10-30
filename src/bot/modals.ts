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

  // Best-effort sender DM used for validation/delivery warnings.
  async function notifySender(text: string): Promise<void> {
    try {
      const dm = await client.conversations.open({ users: senderId })
      if (dm.channel?.id) await client.chat.postMessage({ channel: dm.channel.id, text })
    } catch (err: any) {
      logger.warn({ err, senderId }, 'Failed to DM sender during modal submit')
    }
  }

  // Try to get recipient from modal state.
  // conversations_select returns selected_conversation as a plain string ID:
  // C... = public channel, G... = private channel/group, D... = DM, U... = user.
  const selectedConv: string | null =
    (values.recipient_block?.recipient as any)?.selected_conversation ?? null

  // Optional User Group picker (static_select) -> { selected_option: { value: 'S...' } }
  const selectedUserGroupId: string | null =
    (values.usergroup_block?.usergroup as any)?.selected_option?.value ?? null

  // Optional Group Conversation (mpim) ID field (plain_text_input). Accepts a
  // raw channel id or a pasted Slack conversation link.
  const mpimInput = ((values.mpim_block?.mpim_id as any)?.value ?? '').trim()
  const selectedMpimId: string | null = mpimInput ? extractChannelId(mpimInput) : null

  // Exactly one of the three recipient modes may be set.
  const modesSet = [selectedConv, selectedUserGroupId, selectedMpimId].filter(Boolean)
  if (modesSet.length > 1) {
    logger.warn({ selectedConv, selectedUserGroupId, selectedMpimId }, 'Multiple recipient modes selected')
    await notifySender(
      '⚠️ Please choose only one recipient type: a recipient (person/channel), a user group, OR a group conversation ID.',
    )
    return
  }
  if (modesSet.length === 0) {
    logger.warn('Modal submitted without any recipient')
    await notifySender('⚠️ Please select a recipient, a user group, or a group conversation ID before sending.')
    return
  }

  const isUserGroupRecipient = !!selectedUserGroupId
  const isMpimRecipient = !!selectedMpimId
  // Determine channel vs 1:1 only when not targeting a user group or group conversation.
  const isChannelRecipient =
    !isUserGroupRecipient && !isMpimRecipient && (selectedConv!.startsWith('C') || selectedConv!.startsWith('G'))

  // Validate the group conversation EARLY, before any secret is created. The
  // bot must be a member to enumerate members (conversations.members/info
  // return channel_not_found otherwise), and it must actually be an mpim — a
  // pasted id can be any conversation, so we don't trust the prefix (an mpim
  // can carry a C prefix and is_private=true; only is_mpim is reliable).
  if (isMpimRecipient) {
    try {
      const info = await client.conversations.info({ channel: selectedMpimId! })
      if (!info.ok || !(info.channel as any)?.is_mpim) {
        await notifySender(
          '⚠️ That is not a group conversation (multi-person DM). Please share to a person, a channel, or a user group instead.',
        )
        return
      }
    } catch (err: any) {
      logger.warn({ err, selectedMpimId }, 'Could not access group conversation; likely bot is not a member')
      await notifySender(
        '⚠️ The bot could not access that group conversation. Please add @SecretBot to it first, then try again.',
      )
      return
    }
  }

  let channelRecipientId: string | null = null
  let dmUserId: string | null = null

  if (isUserGroupRecipient || isMpimRecipient) {
    // Delivery is handled by the fan-out worker; no per-recipient id resolved here.
  } else if (isChannelRecipient) {
    channelRecipientId = selectedConv
  } else {
    // selectedConv is a DM conversation ID (D...) or User ID (U...)
    if (selectedConv!.startsWith('U')) {
      dmUserId = selectedConv
    } else {
      // D... DM conversation — resolve member
      const convInfo = await client.conversations.info({ channel: selectedConv! })
      const members: string[] = (convInfo.channel as any)?.members || []
      dmUserId = members.find((m: string) => m !== senderId) ?? null
      if (!dmUserId) {
        logger.error({ selectedConv }, 'Could not resolve DM recipient')
        await notifySender('⚠️ Could not resolve the recipient you selected. Please try again.')
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

    // Determine visibility mode and allowed viewer.
    // - User group / group conversation (mpim): 'multi', allowedViewerId=null (fan-out to members)
    // - Channel: 'multi', allowedViewerId=null
    // - 1:1:     'single', allowedViewerId=dmUserId
    const multiFanOut = isUserGroupRecipient || isChannelRecipient || isMpimRecipient
    const visibilityMode: 'single' | 'multi' = multiFanOut ? 'multi' : 'single'
    const allowedViewerId = multiFanOut ? null : dmUserId

    // Get sender name + a display label for the recipient (used on the
    // sender's own placeholder). For a user group we show the group handle as
    // plain "@handle" text — NOT a <!subteam^> mention, which would notify the
    // whole group from the sender's private DM.
    const senderName = `<@${senderId}>`
    let recipientName: string | null = dmUserId ? `<@${dmUserId}>` : null
    if (isUserGroupRecipient && selectedUserGroupId) {
      try {
        const ug = await client.usergroups.list({ include_count: false })
        const g = (ug.usergroups as any[])?.find((x) => x.id === selectedUserGroupId)
        recipientName = g ? `@${g.handle ?? g.name}` : null
      } catch (err) {
        logger.warn({ err, selectedUserGroupId }, 'Could not resolve user group handle for display')
      }
    }

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

    // User Group recipient: expand the group and DM each member. There is NO
    // channel announcement here - a user group has no channel to announce in.
    if (isUserGroupRecipient && selectedUserGroupId) {
      // Cap check on how many members we would fan out to
      let groupMemberCount = 0
      try {
        const ugMembers = await client.usergroups.users.list({
          usergroup: selectedUserGroupId,
          include_disabled: false,
        })
        const ids = (ugMembers.users as string[]) ?? []
        const botUid = await getBotUserId(client)
        groupMemberCount = ids.filter((m: string) => m !== senderId && m !== botUid).length
      } catch (err) {
        logger.warn({ err, selectedUserGroupId }, 'Could not resolve user group members for cap check')
      }

      const config = getConfig()
      if (groupMemberCount > config.security.max_channel_members) {
        logger.warn({ groupMemberCount, cap: config.security.max_channel_members }, 'User group too large')
        await notifySender(
          `⚠️ That user group has ${groupMemberCount} members, exceeding the cap of ${config.security.max_channel_members}. Secret not delivered.`,
        )
        await dbs.secrets.hardDeleteSecretsForId(secret.id)
        return
      }

      // Enqueue async fan-out — do NOT loop here (ack window constraint)
      await channelDeliveryQueue.add('deliver-usergroup-secret', {
        secretId: secret.id,
        recipientKind: 'usergroup',
        recipientId: selectedUserGroupId,
        senderId,
      })

      logger.info(
        { secretId: secret.id, selectedUserGroupId, groupMemberCount },
        'User group secret delivery enqueued',
      )
    } else if (isMpimRecipient && selectedMpimId) {
      // Group conversation (mpim): fan out a per-member DM, plus an
      // announcement in the conversation (the bot is a member to be here at
      // all). The sender is a member too and is excluded from fan-out, so they
      // only ever see their own control message.
      const botUid = await getBotUserId(client)
      const mpimMemberIds = await resolveChannelMembers(client, selectedMpimId)
      const memberCount = mpimMemberIds.filter((m) => m !== senderId && m !== botUid).length

      const config = getConfig()
      if (memberCount > config.security.max_channel_members) {
        logger.warn({ memberCount, cap: config.security.max_channel_members }, 'Group conversation too large')
        await notifySender(
          `⚠️ That group conversation has ${memberCount} members, exceeding the cap of ${config.security.max_channel_members}. Secret not delivered.`,
        )
        await dbs.secrets.hardDeleteSecretsForId(secret.id)
        return
      }

      // Announcement into the group conversation. Reuse the channel-announcement
      // tracking so revoke/expiry updates it in place. Pass channelName=null +
      // label 'group conversation' (an mpim's real name is an "mpdm-…" slug).
      const announcementBlocks = buildChannelAnnouncementBlocks(`<@${senderId}>`, null, 'group conversation')
      const announcementResult = await client.chat.postMessage({
        channel: selectedMpimId,
        blocks: announcementBlocks,
        text: `<@${senderId}> shared a secret in this group conversation. Check your DMs.`,
      })
      if (announcementResult.ok && announcementResult.ts) {
        await dbs.secrets.setChannelAnnouncementMessage(secret.id, selectedMpimId, announcementResult.ts)
      }

      await channelDeliveryQueue.add('deliver-mpim-secret', {
        secretId: secret.id,
        recipientKind: 'mpim',
        recipientId: selectedMpimId,
        senderId,
      })

      logger.info({ secretId: secret.id, selectedMpimId, memberCount }, 'Group conversation secret delivery enqueued')
    } else if (isChannelRecipient && channelRecipientId) {
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

// Accept a raw Slack conversation id (e.g. "C0CEBDXC2GY") or a pasted Slack
// conversation link (e.g. https://x.slack.com/app_redirect?channel=C0CEBDXC2GY)
// and return just the id. Falls back to the trimmed input if no id-shaped token
// is found (so a malformed value still flows into the conversations.info check,
// which fails it cleanly).
function extractChannelId(input: string): string {
  const matches = input.toUpperCase().match(/[A-Z0-9]{8,}/g)
  return matches && matches.length > 0 ? matches[matches.length - 1] : input.trim()
}

async function downloadFileFromSlack(client: WebClient, urlPrivate: string, urlPrivateDownload: string): Promise<Buffer> {  // Use the bot token to download the file
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
