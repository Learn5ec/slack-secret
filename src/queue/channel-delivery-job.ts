import { WebClient } from '@slack/web-api'
import { Queue } from 'bullmq'
import { logger } from '../utils/logger'
import { createDatabases } from '../db'
import { pool } from '../db/client'
import { buildRecipientPlaceholderBlocks } from '../slack/view-builder'
import { getConfig } from '../config/timing'

export interface ChannelDeliveryPayload {
  secretId: string
  recipientKind?: 'channel' | 'usergroup' | 'mpim'
  recipientId?: string
  // Legacy alias for recipientId (channel), kept so any in-flight job still runs.
  channelId?: string
  senderId: string
}

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

// Expand a Slack User Group into its member user-IDs.
async function resolveGroupMembers(client: WebClient, usergroupId: string): Promise<string[]> {
  const result = await (client as any).usergroups.users.list({ usergroup: usergroupId, include_disabled: false })
  return (result.users as string[]) ?? []
}

export async function processChannelDelivery(
  job: { data: ChannelDeliveryPayload },
  client: WebClient,
  dbs: ReturnType<typeof createDatabases>,
  botUserId: string | null,
): Promise<void> {
  const { secretId, senderId } = job.data
  const kind = job.data.recipientKind ?? 'channel'
  const recipientId = job.data.recipientId ?? job.data.channelId

  if (!recipientId) {
    logger.warn({ secretId }, 'Fan-out job has no recipientId/channelId, skipping')
    return
  }

  const secret = await dbs.secrets.getSecretById(secretId)
  if (!secret || secret.status !== 'pending') {
    logger.warn({ secretId }, 'Secret gone or already consumed before delivery')
    return
  }

  const memberIds =
    kind === 'usergroup'
      ? await resolveGroupMembers(client, recipientId)
      : await resolveChannelMembers(client, recipientId)

  const deliverable = memberIds.filter((m) => m !== senderId && m !== botUserId)
  const noun = kind === 'usergroup' ? 'user group' : kind === 'mpim' ? 'group conversation' : 'channel'

  // Helper to DM the sender about delivery problems.
  async function notifySender(text: string): Promise<void> {
    try {
      const dm = await client.conversations.open({ users: senderId })
      if (dm.channel?.id) await client.chat.postMessage({ channel: dm.channel.id, text })
    } catch (err: any) {
      logger.warn({ err, secretId }, 'Failed to notify sender about fan-out delivery')
    }
  }

  if (deliverable.length === 0) {
    logger.warn({ secretId, recipientId, kind }, 'No deliverable members to fan out to')
    await notifySender(`⚠️ Your secret could not be delivered — the ${noun} has no members who can receive it.`)
    return
  }

  let delivered = 0
  let failed = 0
  for (const memberId of deliverable) {
    try {
      const dmResult = await client.conversations.open({ users: memberId })
      const dmChannelId = dmResult.channel?.id
      if (!dmChannelId) {
        failed++
        continue
      }

      const senderName = `<@${senderId}>`
      const blocks = buildRecipientPlaceholderBlocks(secret.type, senderName, null, secretId)

      const postResult = await client.chat.postMessage({
        channel: dmChannelId,
        blocks,
        text: `${senderName} shared a secret with your ${noun}. Click to view.`,
      })

      if (postResult.ok && postResult.ts) {
        // Record this DM placeholder in the channel_member_dms table (NOT views)
        // so that revoke/expiry can delete the un-opened placeholder independently
        // of the per-user revealed-secret views. Reused for both channel members and
        // user-group members.
        await dbs.channelMemberDms.create({
          secretId,
          memberId,
          dmChannelId,
          dmTs: postResult.ts,
        })
        delivered++
      } else {
        failed++
      }

      // Rate limit: 1 msg/sec per Slack's postMessage limit
      await new Promise((r) => setTimeout(r, 1100))
    } catch (err: any) {
      failed++
      logger.warn({ err, memberId, secretId }, `Failed to DM ${noun} member`)
    }
  }

  if (failed > 0) {
    await notifySender(
      `⚠️ Your secret reached ${delivered} of ${deliverable.length} ${noun} members. ${failed} could not be delivered (they may have DMs disabled or be deactivated).`,
    )
  }

  logger.info({ secretId, recipientId, kind, delivered, failed, total: deliverable.length }, 'Fan-out delivery complete')
}
