import { Pool } from 'pg'
import { logger } from '../utils/logger'
import {
  SecretNotFoundError,
  SecretExpiredError,
  SecretCancelledError,
} from '../utils/errors'

export type SecretRow = {
  id: string
  sender_id: string
  origin_channel_id: string
  origin_ts: string
  type: 'text' | 'file' | 'combined'
  ciphertext: Buffer | null
  iv: Buffer | null
  encrypted_data_key: Buffer | null
  file_path: string | null
  file_name: string | null
  file_size_bytes: number | null
  file_iv: Buffer | null
  file_encrypted_data_key: Buffer | null
  allowed_viewer_id: string | null
  visibility_mode: 'single' | 'multi'
  status: 'pending' | 'consumed' | 'expired' | 'cancelled'
  created_at: Date
  expires_at: Date
  recipient_dm_channel_id: string | null
  recipient_dm_ts: string | null
  viewed_by_channel_id: string | null
  viewed_by_ts: string | null
  sender_placeholder_channel_id: string | null
  sender_placeholder_ts: string | null
}

export function createClient(pool: Pool) {
  const client = {
  createSecret: async (params: {
    senderId: string
    originChannelId: string
    originTs: string
    type: 'text' | 'file' | 'combined'
    ciphertext: Buffer | null
    iv: Buffer | null
    encryptedDataKey?: Buffer | null
    filePath?: string | null
    fileName?: string | null
    fileSizeBytes?: number | null
    fileIv?: Buffer | null
    fileEncryptedDataKey?: Buffer | null
    allowedViewerId?: string | null
    visibilityMode?: 'single' | 'multi'
    expiresAt: Date
  }): Promise<SecretRow> => {
    const result = await pool.query(
      `INSERT INTO secrets
        (sender_id, origin_channel_id, origin_ts, type, ciphertext, iv, encrypted_data_key,
         file_path, file_name, file_size_bytes, file_iv, file_encrypted_data_key,
         allowed_viewer_id, visibility_mode, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        params.senderId,
        params.originChannelId,
        params.originTs,
        params.type,
        params.ciphertext,
        params.iv,
        params.encryptedDataKey ?? null,
        params.filePath ?? null,
        params.fileName ?? null,
        params.fileSizeBytes ?? null,
        params.fileIv ?? null,
        params.fileEncryptedDataKey ?? null,
        params.allowedViewerId ?? null,
        params.visibilityMode ?? 'single',
        params.expiresAt,
      ],
    )
    return result.rows[0] as SecretRow
  },

  getSecretById: async (secretId: string): Promise<SecretRow | null> => {
    const result = await pool.query(
      'SELECT * FROM secrets WHERE id = $1',
      [secretId],
    )
    return (result.rows[0] ?? null) as SecretRow | null
  },

  getSecretByIdForUpdate: async (secretId: string): Promise<SecretRow | null> => {
    const result = await pool.query(
      'SELECT * FROM secrets WHERE id = $1 FOR UPDATE',
      [secretId],
    )
    return (result.rows[0] ?? null) as SecretRow | null
  },

  updateSecretStatus: async (secretId: string, status: SecretRow['status']): Promise<void> => {
    await pool.query(
      'UPDATE secrets SET status = $1 WHERE id = $2',
      [status, secretId],
    )
  },

  setRecipientDmMessage: async (secretId: string, dmChannelId: string, dmTs: string): Promise<void> => {
    await pool.query(
      'UPDATE secrets SET recipient_dm_channel_id = $1, recipient_dm_ts = $2 WHERE id = $3',
      [dmChannelId, dmTs, secretId],
    )
  },

  setViewedByMessage: async (secretId: string, channelId: string, ts: string): Promise<void> => {
    await pool.query(
      'UPDATE secrets SET viewed_by_channel_id = $1, viewed_by_ts = $2 WHERE id = $3',
      [channelId, ts, secretId],
    )
  },

  setSenderPlaceholderMessage: async (secretId: string, channelId: string, ts: string): Promise<void> => {
    await pool.query(
      'UPDATE secrets SET sender_placeholder_channel_id = $1, sender_placeholder_ts = $2 WHERE id = $3',
      [channelId, ts, secretId],
    )
  },

  hardDeleteSecret: async (secretId: string): Promise<number> => {
    const result = await pool.query(
      'DELETE FROM secrets WHERE id = $1',
      [secretId],
    )
    return result.rowCount ?? 0
  },

  hardDeleteSecretsForId: async (secretId: string): Promise<void> => {
    // Delete views first (FK cascade handles secrets), but we do explicit DELETE too
    await pool.query('DELETE FROM views WHERE secret_id = $1', [secretId])
    await pool.query('DELETE FROM secrets WHERE id = $1', [secretId])
  },

  getPendingSecrets: async (): Promise<SecretRow[]> => {
    const result = await pool.query(
      `SELECT * FROM secrets
       WHERE status = 'pending' AND expires_at < now()
       ORDER BY expires_at ASC`,
    )
    return result.rows as SecretRow[]
  },

  getConsumedExpiredSecrets: async (): Promise<SecretRow[]> => {
    const result = await pool.query(
      `SELECT * FROM secrets
       WHERE status = 'consumed' AND expires_at < now()
       ORDER BY expires_at ASC`,
    )
    return result.rows as SecretRow[]
  },
  }

  return client
}

export type SecretsRepo = ReturnType<typeof createClient>
