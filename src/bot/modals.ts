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

// Post the "X shared a secret in …" announcement into a channel / group
// conversation and record it against the secret so revoke/expiry can update it
// in place. Skips silently if this secret was already announced in this exact
// conversation (e.g. forwarding the same secret to the same place twice).
async function announceSecretInConversation(
  client: WebClient,
  dbs: ReturnType<typeof createDatabases>,
  secretId: string,
  senderId: string,
  channelId: string,
  kind: 'channel' | 'mpim',
  channelName?: string | null,
): Promise<void> {
  const existing = await dbs.channelAnnouncements.getBySecretAndChannel(secretId, channelId)
  if (existing) return

  const senderName = `<@${senderId}>`
  const label = kind === 'mpim' ? 'group conversation' : 'channel'
  const blocks = buildChannelAnnouncementBlocks(senderName, kind === 'mpim' ? null : (channelName ?? null), label)
  const fallback = kind === 'mpim'
    ? `${senderName} shared a secret in this group conversation. Check your DMs.`
    : `${senderName} shared a secret in #${channelName ?? 'this channel'}. Check your DMs.`

  const result = await client.chat.postMessage({ channel: channelId, blocks, text: fallback })
  if (result.ok && result.ts) {
    // Keep the legacy single-announcement columns fresh too (harmless; the
    // per-conversation table is now the source of truth for revoke/expiry).
    await dbs.secrets.setChannelAnnouncementMessage(secretId, channelId, result.ts)
    await dbs.channelAnnouncements.record(secretId, channelId, result.ts)
  }
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

  // Each recipient slot is independently optional; one secret fans out to
  // whichever are filled — a single target, any two, or all three at once.
  let includeChannel = false // selectedConv resolves to a channel (C/G)
  let includePerson = false // selectedConv resolves to a person (U/D)
  let includeUserGroup = !!selectedUserGroupId
  let includeMpim = !!selectedMpimId

  if (selectedConv) {
    if (selectedConv.startsWith('C') || selectedConv.startsWith('G')) includeChannel = true
    else includePerson = true // U (user) or D (DM conversation)
  }

  const anyTarget = () => includeChannel || includePerson || includeUserGroup || includeMpim
  let targetCount = [includeChannel, includePerson, includeUserGroup, includeMpim].filter(Boolean).length
  if (targetCount === 0) {
    logger.warn('Modal submitted without any recipient')
    await notifySender('⚠️ Please select a recipient, a user group, or a group conversation ID before sending.')
    return
  }

  // Validate the group conversation EARLY (the bot must be a member to enumerate
  // members, and only is_mpim is a reliable type signal — a pasted id can be any
  // conversation). On failure, skip JUST the group-conversation target rather
  // than aborting the whole submission, unless it was the only target.
  if (includeMpim) {
    try {
      const info = await client.conversations.info({ channel: selectedMpimId! })
      if (!info.ok || !(info.channel as any)?.is_mpim) {
        await notifySender('⚠️ That is not a group conversation (multi-person DM); skipping it.')
        includeMpim = false
      }
    } catch (err: any) {
      logger.warn({ err, selectedMpimId }, 'Could not access group conversation; likely bot is not a member')
      await notifySender('⚠️ The bot could not access that group conversation; skipping it. Add @SecretBot to it first if you want it included.')
      includeMpim = false
    }
    if (!anyTarget()) return
  }

  // Resolve the person recipient (1:1). On failure, skip just that target unless
  // it was the only one.
  let channelRecipientId: string | null = null
  let dmUserId: string | null = null

  if (includeChannel) {
    channelRecipientId = selectedConv
  }
  if (includePerson) {
    if (selectedConv!.startsWith('U')) {
      dmUserId = selectedConv
    } else {
      // D... DM conversation — resolve the other member.
      const convInfo = await client.conversations.info({ channel: selectedConv! })
      const members: string[] = (convInfo.channel as any)?.members || []
      dmUserId = members.find((m: string) => m !== senderId) ?? null
    }
    if (!dmUserId) {
      logger.warn({ selectedConv }, 'Could not resolve DM recipient')
      await notifySender('⚠️ Could not resolve the recipient you selected; skipping them.')
      includePerson = false
      if (!anyTarget()) return
    }
  }

  // Final surviving target set (some slots may have been skipped above).
  targetCount = [includeChannel, includePerson, includeUserGroup, includeMpim].filter(Boolean).length
  const isUserGroupRecipient = includeUserGroup
  const isMpimRecipient = includeMpim
  const isChannelRecipient = includeChannel
  const isPersonRecipient = includePerson

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

    // Reveal is ungated ('multi') whenever there's fan-out to a channel/user
    // group/group-conversation OR more than one recipient is targeted; a lone 1:1
    // person stays 'single' (locked to that viewer).
    const multiFanOut = targetCount > 1 || isUserGroupRecipient || isChannelRecipient || isMpimRecipient
    const visibilityMode: 'single' | 'multi' = multiFanOut ? 'multi' : 'single'
    const allowedViewerId = multiFanOut ? null : dmUserId

    // Display label on the sender's own placeholder. A single target shows the
    // concrete recipient (a person @mention, or the user group's plain "@handle" —
    // never a <!subteam^> mention, which would notify the whole group from the
    // sender's private DM). Multiple targets show a count instead.
    const senderName = `<@${senderId}>`
    let recipientName: string | null
    if (targetCount > 1) {
      recipientName = `${targetCount} recipients`
    } else if (isUserGroupRecipient && selectedUserGroupId) {
      recipientName = null
      try {
        const ug = await client.usergroups.list({ include_count: false })
        const g = (ug.usergroups as any[])?.find((x) => x.id === selectedUserGroupId)
        recipientName = g ? `@${g.handle ?? g.name}` : null
      } catch (err) {
        logger.warn({ err, selectedUserGroupId }, 'Could not resolve user group handle for display')
      }
    } else {
      recipientName = dmUserId ? `<@${dmUserId}>` : null
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

    // Deliver to each surviving target INDEPENDENTLY so one secret fans out to any
    // combination of person / user group / group conversation / channel. A target
    // that fails its own cap/access check is skipped with a note to the sender —
    // it no longer aborts the whole submission. `deliveredAny` tracks whether
    // anything went out; if nothing did, the secret is discarded below.
    let deliveredAny = false
    const botUid = await getBotUserId(client)

    // User group — fan out to each member (no channel announcement: a user group
    // has no channel to announce in).
    if (isUserGroupRecipient && selectedUserGroupId) {
      let groupMemberCount = 0
      try {
        const ugMembers = await client.usergroups.users.list({
          usergroup: selectedUserGroupId,
          include_disabled: false,
        })
        const ids = (ugMembers.users as string[]) ?? []
        groupMemberCount = ids.filter((m: string) => m !== senderId && m !== botUid).length
      } catch (err) {
        logger.warn({ err, selectedUserGroupId }, 'Could not resolve user group members for cap check')
      }

      if (groupMemberCount > config.security.max_channel_members) {
        logger.warn({ groupMemberCount, cap: config.security.max_channel_members }, 'User group too large')
        await notifySender(
          `⚠️ That user group has ${groupMemberCount} members, exceeding the cap of ${config.security.max_channel_members}; it was skipped.`,
        )
      } else {
        await channelDeliveryQueue.add('deliver-usergroup-secret', {
          secretId: secret.id,
          recipientKind: 'usergroup',
          recipientId: selectedUserGroupId,
          senderId,
        })
        deliveredAny = true
        logger.info(
          { secretId: secret.id, selectedUserGroupId, groupMemberCount },
          'User group secret delivery enqueued',
        )
      }
    }

    // Group conversation (mpim) — per-member DM + an announcement in the
    // conversation. Cap-checked before announcing so we never post an announcement
    // for a delivery we then drop.
    if (isMpimRecipient && selectedMpimId) {
      const mpimMemberIds = await resolveChannelMembers(client, selectedMpimId)
      const memberCount = mpimMemberIds.filter((m) => m !== senderId && m !== botUid).length

      if (memberCount > config.security.max_channel_members) {
        logger.warn({ memberCount, cap: config.security.max_channel_members }, 'Group conversation too large')
        await notifySender(
          `⚠️ That group conversation has ${memberCount} members, exceeding the cap of ${config.security.max_channel_members}; it was skipped.`,
        )
      } else {
        // An mpim's real name is an "mpdm-…" slug, so announce with the
        // 'group conversation' label; the per-conversation table lets
        // revoke/expiry update it in place.
        await announceSecretInConversation(client, dbs, secret.id, senderId, selectedMpimId, 'mpim')
        await channelDeliveryQueue.add('deliver-mpim-secret', {
          secretId: secret.id,
          recipientKind: 'mpim',
          recipientId: selectedMpimId,
          senderId,
        })
        deliveredAny = true
        logger.info({ secretId: secret.id, selectedMpimId, memberCount }, 'Group conversation secret delivery enqueued')
      }
    }

    // Channel — bot joins a public channel if needed (private channels the bot
    // isn't in are skipped, never force-joined), announces, then fans out.
    if (isChannelRecipient && channelRecipientId) {
      const channelInfo = await client.conversations.info({ channel: channelRecipientId })
      const isMember = channelInfo.channel?.is_member
      const isPrivate = channelInfo.channel?.is_private
      const channelName = (channelInfo.channel as any)?.name ?? null

      const memberIds = await resolveChannelMembers(client, channelRecipientId)
      const memberCount = memberIds.filter((m: string) => m !== senderId && m !== botUid).length

      if (!isMember && isPrivate) {
        logger.warn({ channelRecipientId }, 'Bot not in private channel, cannot deliver')
        await notifySender(
          `⚠️ The bot is not in the private channel <#${channelRecipientId}>; it was skipped. Invite @SecretBot to that channel first if you want it included.`,
        )
      } else if (memberCount > config.security.max_channel_members) {
        logger.warn({ memberCount, cap: config.security.max_channel_members }, 'Channel too large')
        await notifySender(
          `⚠️ Channel has ${memberCount} members, exceeding the cap of ${config.security.max_channel_members}; it was skipped.`,
        )
      } else {
        if (!isMember) {
          await client.conversations.join({ channel: channelRecipientId })
          logger.info({ channelRecipientId }, 'Bot joined public channel')
        }
        await announceSecretInConversation(client, dbs, secret.id, senderId, channelRecipientId, 'channel', channelName)

        await channelDeliveryQueue.add('deliver-channel-secret', {
          secretId: secret.id,
          channelId: channelRecipientId,
          senderId,
        })
        deliveredAny = true
        logger.info({ secretId: secret.id, channelRecipientId }, 'Channel secret delivery enqueued')
      }
    }

    // 1:1 person — recipient gets their own View Secret DM.
    if (isPersonRecipient && dmUserId) {
      const dmResult = await client.conversations.open({ users: dmUserId })
      const dmChannelId = dmResult.channel?.id
      if (dmChannelId) {
        const recipientPlaceholderBlocks = buildRecipientPlaceholderBlocks(
          secretType,
          senderName,
          `<@${dmUserId}>`,
          secret.id,
        )
        const dmPostResult = await client.chat.postMessage({
          channel: dmChannelId,
          blocks: recipientPlaceholderBlocks,
          text: `Secret from ${senderName}`,
        })
        if (dmPostResult.ok) {
          deliveredAny = true
          // Explicit reveal grant for a person inside a combined (multi) secret;
          // harmless no-op that also covers the lone single-mode case.
          await dbs.allowedViewers.create(secret.id, dmUserId)
          await dbs.secrets.setRecipientDmMessage(secret.id, dmChannelId, dmPostResult.ts!)
          logger.info({ secretId: secret.id, dmChannelId }, 'Recipient DM posted')
        } else {
          logger.error({ err: dmPostResult.error }, 'Failed to post recipient DM')
        }
      } else {
        logger.warn({ recipientId: dmUserId }, 'Failed to open DM channel')
      }
    }

    // Nothing reached anyone (every target failed its own check) — don't leave a
    // dangling secret behind.
    if (!deliveredAny) {
      logger.warn({ secretId: secret.id }, 'No recipient could be delivered to; discarding secret')
      await dbs.secrets.hardDeleteSecretsForId(secret.id)
      await notifySender('⚠️ The secret could not be delivered to any of the selected recipients.')
    }
  } catch (err: any) {
    logger.error({ err, errMessage: err.message, errStack: err.stack }, 'Error processing modal submission')
  }
}

// Forward an EXISTING secret to more recipients — no re-encryption, no new
// announcement. Reuses the same three recipient modes as the creation modal
// (person / user group / group-conversation id) plus a channel selected in the
// dropdown. Each target is fanned out as per-person "View Secret" DMs by the
// shared delivery worker, which also records the allow-list grant so forwarded
// people pass a single-mode secret's reveal check.
export async function handleShareSubmit(args: ModalSubmitArgs): Promise<void> {
  const { view, ack, body, client } = args

  await ack()

  const values = view.state.values
  const senderId = body.user.id
  const secretId = (view as any).private_metadata as string | undefined

  async function notifySender(text: string): Promise<void> {
    try {
      const dm = await client.conversations.open({ users: senderId })
      if (dm.channel?.id) await client.chat.postMessage({ channel: dm.channel.id, text })
    } catch (err: any) {
      logger.warn({ err, senderId }, 'Failed to DM sender during share submit')
    }
  }

  try {
    if (!secretId) {
      logger.warn('Share submit without secretId in private_metadata')
      return
    }

    const dbs = createDatabases(pool)
    const secret = await dbs.secrets.getSecretById(secretId)
    if (!secret) {
      await notifySender('⚠️ That secret no longer exists.')
      return
    }
    if (secret.sender_id !== senderId) {
      logger.warn({ secretId, senderId }, 'Non-sender attempted to forward a secret')
      await notifySender('⚠️ Only the person who shared this secret can forward it.')
      return
    }
    if (secret.status !== 'pending') {
      await notifySender('⚠️ This secret is no longer available to forward (it has been revoked or expired).')
      return
    }

    // Same three-mode extraction as the creation modal.
    const selectedConv: string | null =
      (values.recipient_block?.recipient as any)?.selected_conversation ?? null
    const selectedUserGroupId: string | null =
      (values.usergroup_block?.usergroup as any)?.selected_option?.value ?? null
    const mpimInput = ((values.mpim_block?.mpim_id as any)?.value ?? '').trim()
    const selectedMpimId: string | null = mpimInput ? extractChannelId(mpimInput) : null

    if ([selectedConv, selectedUserGroupId, selectedMpimId].filter(Boolean).length === 0) {
      await notifySender('⚠️ Please select a recipient, a user group, or a group conversation ID before forwarding.')
      return
    }

    const config = getConfig()
    const botUid = await getBotUserId(client)

    // Enqueue a fan-out job for one entity and confirm to the sender. `noun` is
    // display-only. Each entity forwarded to is confirmed independently.
    async function fanOut(payload: {
      recipientKind: 'channel' | 'usergroup' | 'mpim'
      recipientId: string
      noun: string
    }): Promise<void> {
      await channelDeliveryQueue.add(`forward-${payload.recipientKind}-secret`, {
        secretId: secretId!,
        recipientKind: payload.recipientKind,
        recipientId: payload.recipientId,
        senderId,
      })
      logger.info({ secretId, recipientId: payload.recipientId, kind: payload.recipientKind }, 'Forward fan-out enqueued')
      await notifySender(`🔗 Forwarded to ${payload.noun}. Each person gets their own one-time View Secret DM.`)
    }

    // Every filled slot is forwarded independently: any single target, any two, or
    // all three. A target failing its own cap/access check is skipped with a note
    // while the rest still go out. The worker de-duplicates anyone reached through
    // more than one entity and reports them to the sender.

    // 1) User Group → expand + DM each member (works without bot membership).
    if (selectedUserGroupId) {
      let count = 0
      try {
        const ug = await client.usergroups.users.list({ usergroup: selectedUserGroupId, include_disabled: false })
        count = ((ug.users as string[]) ?? []).filter((m) => m !== senderId && m !== botUid).length
      } catch (err) {
        logger.warn({ err, selectedUserGroupId }, 'Could not resolve user group members for forward cap check')
      }
      if (count > config.security.max_channel_members) {
        await notifySender(
          `⚠️ That user group has ${count} members, exceeding the cap of ${config.security.max_channel_members}; it was skipped.`,
        )
      } else {
        await fanOut({ recipientKind: 'usergroup', recipientId: selectedUserGroupId, noun: `the user group (${count})` })
      }
    }

    // 2) Group Conversation ID field → must be an mpim the bot is a member of.
    if (selectedMpimId) {
      try {
        const info = await client.conversations.info({ channel: selectedMpimId })
        if (!info.ok || !(info.channel as any)?.is_mpim) {
          await notifySender('⚠️ That is not a group conversation (multi-person DM); skipping it.')
        } else {
          await announceSecretInConversation(client, dbs, secretId, senderId, selectedMpimId, 'mpim')
          await fanOut({ recipientKind: 'mpim', recipientId: selectedMpimId, noun: 'the group conversation' })
        }
      } catch (err: any) {
        logger.warn({ err, selectedMpimId }, 'Could not access group conversation for forward; bot likely not a member')
        await notifySender('⚠️ The bot could not access that group conversation; skipping it. Add @SecretBot to it first if you want it included.')
      }
    }

    // 3) conversations_select value: C/G = channel fan-out (channel or mpim).
    if (selectedConv && (selectedConv.startsWith('C') || selectedConv.startsWith('G'))) {
      let isMpim = false
      let channelName: string | null = null
      let accessible = true
      try {
        const info = await client.conversations.info({ channel: selectedConv })
        if (!info.ok || !info.channel?.is_member) {
          await notifySender(`⚠️ The bot is not in <#${selectedConv}>; skipping it. Invite @SecretBot to that conversation first if you want it included.`)
          accessible = false
        } else {
          isMpim = !!(info.channel as any).is_mpim
          channelName = (info.channel as any)?.name ?? null
        }
      } catch (err: any) {
        logger.warn({ err, selectedConv }, 'Could not access conversation for forward; bot likely not a member')
        await notifySender('⚠️ The bot could not access that conversation; skipping it. Add @SecretBot to it first if you want it included.')
        accessible = false
      }
      if (accessible) {
        const memberIds = await resolveChannelMembers(client, selectedConv)
        const memberCount = memberIds.filter((m) => m !== senderId && m !== botUid).length
        if (memberCount > config.security.max_channel_members) {
          await notifySender(
            `⚠️ That conversation has ${memberCount} members, exceeding the cap of ${config.security.max_channel_members}; it was skipped.`,
          )
        } else {
          await announceSecretInConversation(client, dbs, secretId, senderId, selectedConv, isMpim ? 'mpim' : 'channel', isMpim ? null : channelName)
          await fanOut({
            recipientKind: isMpim ? 'mpim' : 'channel',
            recipientId: selectedConv,
            noun: isMpim ? 'the group conversation' : `the channel (${memberCount})`,
          })
        }
      }
    }

    // Person (U... direct, or D... DM conversation to resolve) via the select.
    if (selectedConv && (selectedConv.startsWith('U') || selectedConv.startsWith('D'))) {
      let personId: string | null = null
      if (selectedConv.startsWith('U')) {
        personId = selectedConv
      } else {
        const convInfo = await client.conversations.info({ channel: selectedConv })
        const members: string[] = (convInfo.channel as any)?.members || []
        personId = members.find((m: string) => m !== senderId) ?? null
      }
      if (!personId) {
        await notifySender('⚠️ Could not resolve the recipient you selected; skipping them.')
      } else if (personId === senderId) {
        await notifySender('⚠️ You cannot forward a secret to yourself — you already have it.')
      } else {
        await channelDeliveryQueue.add('forward-user-secret', {
          secretId,
          recipientKind: 'users',
          recipientIds: [personId],
          senderId,
        })
        logger.info({ secretId, personId }, 'Forward to person enqueued')
        await notifySender('🔗 Forwarded. They got their own one-time View Secret DM.')
      }
    }
  } catch (err: any) {
    logger.error({ err, errMessage: err.message }, 'Error processing forward (share) submission')
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
