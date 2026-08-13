import { WebClient } from '@slack/web-api'
import { Queue } from 'bullmq'
import { logger } from '../utils/logger'
import { createDatabases } from '../db'
import { pool } from '../db/client'
import { buildRecipientPlaceholderBlocks } from '../slack/view-builder'
import { getConfig } from '../config/timing'

export interface ChannelDeliveryPayload {
  secretId: string
  channelId: string
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

export async function processChannelDelivery(
  job: { data: ChannelDeliveryPayload },
  client: WebClient,
  dbs: ReturnType<typeof createDatabases>,
  botUserId: string | null,
): Promise<void> {
  const { secretId, channelId, senderId } = job.data

  const secret = await dbs.secrets.getSecretById(secretId)
  if (!secret || secret.status !== 'pending') {
    logger.warn({ secretId }, 'Secret gone or already consumed before channel delivery')
    return
  }

  const memberIds = await resolveChannelMembers(client, channelId)
  const config = getConfig()
  const deleteAt = new Date(Date.now() + config.timing.secret_expiry_ms)

  let delivered = 0
  for (const memberId of memberIds) {
    if (memberId === senderId || memberId === botUserId) continue

    try {
      const dmResult = await client.conversations.open({ users: memberId })
      const dmChannelId = dmResult.channel?.id
      if (!dmChannelId) continue

      const senderName = `<@${senderId}>`
      const blocks = buildRecipientPlaceholderBlocks(secret.type, senderName, null, secretId)

      const postResult = await client.chat.postMessage({
        channel: dmChannelId,
        blocks,
        text: `${senderName} shared a secret with your channel. Click to view.`,
      })

      if (postResult.ok && postResult.ts) {
        await dbs.views.createDeliveredView({
          secretId,
          viewerId: memberId,
          dmChannelId,
          dmTs: postResult.ts,
          deleteAt,
        })
        delivered++
      }

      // Rate limit: 1 msg/sec per Slack's postMessage limit
      await new Promise((r) => setTimeout(r, 1100))
    } catch (err: any) {
      logger.warn({ err, memberId, secretId }, 'Failed to DM channel member')
    }
  }

  logger.info({ secretId, channelId, delivered, totalMembers: memberIds.length }, 'Channel secret delivery complete')
}
