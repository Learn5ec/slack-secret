import { Pool } from 'pg'

export type ChannelAnnouncementRow = {
  id: string
  secret_id: string
  channel_id: string
  ts: string
  created_at: Date
}

export function createClient(pool: Pool) {
  const client = {
    // Record (or refresh) the announcement message for one conversation.
    record: async (secretId: string, channelId: string, ts: string): Promise<void> => {
      await pool.query(
        `INSERT INTO channel_announcements (secret_id, channel_id, ts)
         VALUES ($1, $2, $3)
         ON CONFLICT (secret_id, channel_id) DO UPDATE SET ts = EXCLUDED.ts`,
        [secretId, channelId, ts],
      )
    },

    getBySecretId: async (secretId: string): Promise<ChannelAnnouncementRow[]> => {
      const result = await pool.query(
        'SELECT * FROM channel_announcements WHERE secret_id = $1',
        [secretId],
      )
      return result.rows as ChannelAnnouncementRow[]
    },

    getBySecretAndChannel: async (secretId: string, channelId: string): Promise<ChannelAnnouncementRow | null> => {
      const result = await pool.query(
        'SELECT * FROM channel_announcements WHERE secret_id = $1 AND channel_id = $2',
        [secretId, channelId],
      )
      return (result.rows[0] ?? null) as ChannelAnnouncementRow | null
    },

    deleteBySecretId: async (secretId: string): Promise<number> => {
      const result = await pool.query('DELETE FROM channel_announcements WHERE secret_id = $1', [secretId])
      return result.rowCount ?? 0
    },
  }

  return client
}

export type ChannelAnnouncementsRepo = ReturnType<typeof createClient>
