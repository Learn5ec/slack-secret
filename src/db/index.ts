import { Pool } from 'pg'
import { SecretsRepo, createClient as createSecretsClient } from './secrets'
import { ViewsRepo, createClient as createViewsClient } from './views'
import { ChannelMemberDmsRepo, createClient as createChannelMemberDmsClient } from './channel-member-dms'
import { AllowedViewersRepo, createClient as createAllowedViewersClient } from './allowed-viewers'
import { ChannelAnnouncementsRepo, createClient as createChannelAnnouncementsClient } from './channel-announcements'

export { SecretsRepo, ViewsRepo, ChannelMemberDmsRepo, AllowedViewersRepo, ChannelAnnouncementsRepo }

export function createDatabases(pool: Pool) {
  return {
    secrets: createSecretsClient(pool),
    views: createViewsClient(pool),
    channelMemberDms: createChannelMemberDmsClient(pool),
    allowedViewers: createAllowedViewersClient(pool),
    channelAnnouncements: createChannelAnnouncementsClient(pool),
  }
}
