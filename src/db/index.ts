import { Pool } from 'pg'
import { SecretsRepo, createClient as createSecretsClient } from './secrets'
import { ViewsRepo, createClient as createViewsClient } from './views'

export { SecretsRepo, ViewsRepo }

export function createDatabases(pool: Pool) {
  return {
    secrets: createSecretsClient(pool),
    views: createViewsClient(pool),
  }
}
