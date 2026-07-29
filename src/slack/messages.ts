import { WebClient } from '@slack/web-api'
import { logger } from '../utils/logger'

export async function deleteSlackMessage(client: WebClient, channel: string, ts: string): Promise<void> {
  try {
    await client.chat.delete({ channel, ts })
  } catch (err: any) {
    if (err.code === 'message_not_found') {
      logger.warn({ channel, ts }, 'Message already deleted')
    } else {
      // Never throw: callers (Revoke, Hide, the auto-delete job) loop over
      // multiple messages/views and must not abort partway on one bad delete.
      logger.error({ err, channel, ts }, 'Failed to delete message')
    }
  }
}
