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

// chat.delete on a file-sharing message only removes the message - the
// underlying file object persists in Slack independently unless separately
// purged via files.delete. Only call this for files the BOT itself uploaded
// (e.g. via files.uploadV2): a bot token can never delete a file owned by a
// different user, regardless of scopes (cant_delete_file).
export async function deleteSlackFile(client: WebClient, fileId: string): Promise<void> {
  try {
    await client.files.delete({ file: fileId })
  } catch (err: any) {
    const slackError = err?.data?.error
    if (slackError === 'file_not_found' || slackError === 'cant_delete_file') {
      logger.warn({ fileId, slackError }, 'Could not delete file (already gone or not bot-owned)')
    } else {
      logger.error({ err, fileId }, 'Failed to delete file')
    }
  }
}
