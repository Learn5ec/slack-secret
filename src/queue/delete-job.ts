import { WebClient } from '@slack/web-api'
import { logger } from '../utils/logger'
import { ViewsRepo } from '../db/views'
import { deleteSlackMessage } from '../slack/messages'
import { DeleteDmMessagePayload } from './client'

export async function processDeleteDmMessage(
  job: { data: DeleteDmMessagePayload },
  slackClient: WebClient,
  viewsRepo: ViewsRepo,
): Promise<void> {
  const { viewId, secretId } = job.data

  const view = await viewsRepo.getViewById(viewId)
  if (!view) {
    logger.warn({ secretId, viewId }, 'View not found for delete job, skipping')
    return
  }

  if (view.status === 'deleted') {
    logger.info({ secretId, viewId }, 'View already deleted, skipping')
    return
  }

  if (!view.dm_channel_id || !view.dm_ts) {
    logger.warn({ secretId, viewId }, 'View has no dm_channel_id/dm_ts, cannot delete message')
    await viewsRepo.markViewAsDeleted(viewId)
    return
  }

  await deleteSlackMessage(slackClient, view.dm_channel_id, view.dm_ts)
  await viewsRepo.markViewAsDeleted(viewId)
  logger.info({ secretId, viewId }, 'Deleted revealed-secret message for secret')
}
