import { Pool } from 'pg'
import { logger } from '../utils/logger'

export type ChannelMemberDmRow = {
  id: string
  secret_id: string
  member_id: string
  dm_channel_id: string
  dm_ts: string
  recipient_kind: string | null
  recipient_id: string | null
  created_at: Date
}

export function createClient(pool: Pool) {
  const client = {
    create: async (params: {
      secretId: string
      memberId: string
      dmChannelId: string
      dmTs: string
      recipientKind?: string | null
      recipientId?: string | null
    }): Promise<ChannelMemberDmRow> => {
      const result = await pool.query(
        `INSERT INTO channel_member_dms (secret_id, member_id, dm_channel_id, dm_ts, recipient_kind, recipient_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (secret_id, member_id) DO NOTHING
         RETURNING *`,
        [params.secretId, params.memberId, params.dmChannelId, params.dmTs, params.recipientKind ?? null, params.recipientId ?? null],
      )
      if (result.rows.length === 0) {
        // Already exists - return the existing row
        const existing = await client.getBySecretAndMember(params.secretId, params.memberId)
        if (!existing) {
          throw new Error(`Channel member DM row not found for secret_id=${params.secretId}, member_id=${params.memberId}`)
        }
        return existing
      }
      return result.rows[0] as ChannelMemberDmRow
    },

    getBySecretAndMember: async (secretId: string, memberId: string): Promise<ChannelMemberDmRow | null> => {
      const result = await pool.query(
        'SELECT * FROM channel_member_dms WHERE secret_id = $1 AND member_id = $2',
        [secretId, memberId],
      )
      return (result.rows[0] ?? null) as ChannelMemberDmRow | null
    },

    getBySecretId: async (secretId: string): Promise<ChannelMemberDmRow[]> => {
      const result = await pool.query(
        'SELECT * FROM channel_member_dms WHERE secret_id = $1',
        [secretId],
      )
      return result.rows as ChannelMemberDmRow[]
    },

    deleteBySecretId: async (secretId: string): Promise<number> => {
      const result = await pool.query(
        'DELETE FROM channel_member_dms WHERE secret_id = $1',
        [secretId],
      )
      return result.rowCount ?? 0
    },

    // Remove a single member's placeholder-DM row (per-recipient access removal).
    deleteBySecretAndMember: async (secretId: string, memberId: string): Promise<number> => {
      const result = await pool.query(
        'DELETE FROM channel_member_dms WHERE secret_id = $1 AND member_id = $2',
        [secretId, memberId],
      )
      return result.rowCount ?? 0
    },

    // All members reached through one entity (a channel / user group / group
    // conversation), used by the Manage modal to revoke a whole entity at once.
    listBySecretAndRecipient: async (
      secretId: string,
      recipientKind: string,
      recipientId: string,
    ): Promise<ChannelMemberDmRow[]> => {
      const result = await pool.query(
        'SELECT * FROM channel_member_dms WHERE secret_id = $1 AND recipient_kind = $2 AND recipient_id = $3',
        [secretId, recipientKind, recipientId],
      )
      return result.rows as ChannelMemberDmRow[]
    },
  }

  return client
}

export type ChannelMemberDmsRepo = ReturnType<typeof createClient>
