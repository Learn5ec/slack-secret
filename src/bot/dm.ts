import { WebClient } from '@slack/web-api'
import { logger } from '../utils/logger'

export async function openDmChannel(slackClient: WebClient, userId: string): Promise<{ channelId: string }> {
  try {
    const result = await slackClient.conversations.open({ users: userId })

    if (!result.channel?.id) {
      throw new Error('Failed to open DM channel')
    }

    logger.info({ channelId: result.channel.id, userId }, 'DM channel opened')
    return { channelId: result.channel.id }
  } catch (err) {
    logger.error({ err, userId }, 'Failed to open DM channel')
    throw err
  }
}
