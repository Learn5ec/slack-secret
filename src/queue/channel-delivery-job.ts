import { WebClient } from '@slack/web-api'
import { Queue } from 'bullmq'
import { logger } from '../utils/logger'
import { createDatabases } from '../db'
import { pool } from '../db/client'
import { buildRecipientPlaceholderBlocks } from '../slack/view-builder'
import { getConfig } from '../config/timing'

export interface ChannelDeliveryPayload {
  secretId: string
  recipientKind?: 'channel' | 'usergroup' | 'mpim' | 'users'
  recipientId?: string
  // Explicit user-IDs for the 'users' kind (forward to specific people).
  recipientIds?: string[]
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

  // 'users' forwards target an explicit list of user-IDs (no conversation to
  // enumerate); every other kind resolves members from recipientId.
  if (kind !== 'users' && !recipientId) {
    logger.warn({ secretId }, 'Fan-out job has no recipientId/channelId, skipping')
    return
  }

  const secret = await dbs.secrets.getSecretById(secretId)
  if (!secret || secret.status !== 'pending') {
    logger.warn({ secretId }, 'Secret gone or already consumed before delivery')
    return
  }

  let memberIds: string[]
  if (kind === 'users') {
    memberIds = job.data.recipientIds ?? []
  } else if (kind === 'usergroup') {
    memberIds = await resolveGroupMembers(client, recipientId!)
  } else {
    memberIds = await resolveChannelMembers(client, recipientId!)
  }

  const deliverable = memberIds.filter((m) => m !== senderId && m !== botUserId)
  const noun =
    kind === 'usergroup' ? 'user group' : kind === 'mpim' ? 'group conversation' : kind === 'users' ? 'chat' : 'channel'

  // Human-readable entity the secret reached the recipient through ("via #general",
  // "via @engineering", "via a group conversation"). Best-effort: falls back to a
  // generic label if the name lookup fails. Person ('users') forwards have no
  // entity to name.
  async function resolveEntityLabel(): Promise<string | null> {
    if (kind === 'users') return null
    try {
      if (kind === 'channel') {
        const info = await client.conversations.info({ channel: recipientId! })
        const name = (info.channel as any)?.name
        return name ? `#${name}` : 'a channel'
      }
      if (kind === 'usergroup') {
        const groups = await client.usergroups.list({ include_count: false, include_disabled: true })
        const g = (groups.usergroups ?? []).find((x: any) => x.id === recipientId)
        return g ? `@${g.handle ?? g.name}` : 'a user group'
      }
      return 'a group conversation'
    } catch (err: any) {
      logger.warn({ err, kind, recipientId }, 'Could not resolve entity label for recipient DM')
      return kind === 'channel' ? 'a channel' : kind === 'usergroup' ? 'a user group' : 'a group conversation'
    }
  }
  const entityLabel = await resolveEntityLabel()

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
  let skipped = 0
  // Members who already received this secret (from an earlier target in a
  // combined submit, or a prior Share/forward). We skip them and report them to
  // the sender so a person sitting in several selected groups isn't re-DM'd.
  const alreadyHad: string[] = []
  for (const memberId of deliverable) {
    try {
      // Dedup: a repeated forward to the same audience must not spam a second
      // "View Secret" DM to someone who already has (or already viewed) it.
      const existingDm = await dbs.channelMemberDms.getBySecretAndMember(secretId, memberId)
      const existingView = await dbs.views.getView(secretId, memberId)
      if (existingDm || (existingView && existingView.status === 'delivered')) {
        skipped++
        alreadyHad.push(memberId)
        // Still ensure the reveal grant exists (harmless no-op if present, and
        // required for a single-mode secret reached via a fan-out target).
        await dbs.allowedViewers.create(secretId, memberId)
        continue
      }

      const dmResult = await client.conversations.open({ users: memberId })
      const dmChannelId = dmResult.channel?.id
      if (!dmChannelId) {
        failed++
        continue
      }

      const senderName = `<@${senderId}>`
      const blocks = buildRecipientPlaceholderBlocks(secret.type, senderName, null, secretId, entityLabel)

      const postResult = await client.chat.postMessage({
        channel: dmChannelId,
        blocks,
        text: `${senderName} shared a secret with you${entityLabel ? ` via ${entityLabel}` : ''}. Click to view.`,
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
          recipientKind: kind,
          recipientId: recipientId ?? null,
        })
        // Recipients must pass the single-mode reveal check — add them to the
        // explicit allow-list (no-op for multi-mode secrets, which ignore it).
        // Recorded for every kind so a single-mode secret forwarded to a group
        // still lets its members reveal.
        await dbs.allowedViewers.create(secretId, memberId)
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

  // Tell the sender who we intentionally skipped because they already have the
  // secret (shared via another selected target or an earlier forward), so
  // overlapping groups don't result in silent duplicate-DM suppression.
  if (alreadyHad.length > 0) {
    const names = alreadyHad.map((m) => `<@${m}>`).join(', ')
    await notifySender(
      `🔒 ${names} already received this secret, so it wasn't sent to them again.`,
    )
  }

  logger.info(
    { secretId, recipientId, kind, delivered, failed, skipped, alreadyHad: alreadyHad.length, total: deliverable.length },
    'Fan-out delivery complete',
  )
}
