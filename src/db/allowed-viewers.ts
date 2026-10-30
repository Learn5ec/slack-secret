import { Pool } from 'pg'

export type AllowedViewerRow = {
  secret_id: string
  viewer_id: string
  created_at: Date
}

// Explicit per-secret viewer allow-list. Written when a secret is forwarded to
// specific people (see channel-delivery fan-out). A 'single'-mode secret's
// reveal check treats anyone listed here as an allowed viewer, so forwarding a
// 1:1 secret never has to widen it to 'multi' ("anyone with the button").
export function createClient(pool: Pool) {
  const client = {
    create: async (secretId: string, viewerId: string): Promise<void> => {
      await pool.query(
        `INSERT INTO secret_allowed_viewers (secret_id, viewer_id)
         VALUES ($1, $2)
         ON CONFLICT (secret_id, viewer_id) DO NOTHING`,
        [secretId, viewerId],
      )
    },

    isAllowed: async (secretId: string, viewerId: string): Promise<boolean> => {
      const result = await pool.query(
        'SELECT 1 FROM secret_allowed_viewers WHERE secret_id = $1 AND viewer_id = $2',
        [secretId, viewerId],
      )
      return result.rowCount ? result.rowCount > 0 : false
    },

    listBySecretId: async (secretId: string): Promise<AllowedViewerRow[]> => {
      const result = await pool.query(
        'SELECT * FROM secret_allowed_viewers WHERE secret_id = $1',
        [secretId],
      )
      return result.rows as AllowedViewerRow[]
    },

    deleteBySecretAndViewer: async (secretId: string, viewerId: string): Promise<number> => {
      const result = await pool.query(
        'DELETE FROM secret_allowed_viewers WHERE secret_id = $1 AND viewer_id = $2',
        [secretId, viewerId],
      )
      return result.rowCount ?? 0
    },
  }

  return client
}

export type AllowedViewersRepo = ReturnType<typeof createClient>
