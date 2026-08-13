import { Pool } from 'pg'
import { SecretsRepo, createClient as createSecretsClient } from './secrets'
import { ViewsRepo, createClient as createViewsClient } from './views'
import { ChannelMemberDmsRepo, createClient as createChannelMemberDmsClient } from './channel-member-dms'

export { SecretsRepo, ViewsRepo, ChannelMemberDmsRepo }

export function createDatabases(pool: Pool) {
  return {
    secrets: createSecretsClient(pool),
    views: createViewsClient(pool),
    channelMemberDms: createChannelMemberDmsClient(pool),
  }
}
