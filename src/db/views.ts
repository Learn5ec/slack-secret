import { Pool } from 'pg'

export type ViewRow = {
  id: string
  secret_id: string
  viewer_id: string
  dm_channel_id: string | null
  dm_ts: string | null
  file_dm_ts: string | null
  file_upload_id: string | null
  delivered_at: Date | null
  delete_at: Date | null
  status: 'delivered' | 'deleted' | 'failed'
}

export function createClient(pool: Pool) {
  const client = {
  createDeliveredView: async (params: {
    secretId: string
    viewerId: string
    dmChannelId: string
    dmTs: string | null
    fileDmTs?: string | null
    fileUploadId?: string | null
    deleteAt: Date
  }): Promise<{ created: boolean; view: ViewRow | null }> => {
    const result = await pool.query(
      `INSERT INTO views (secret_id, viewer_id, dm_channel_id, dm_ts, file_dm_ts, file_upload_id, delivered_at, delete_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7, 'delivered')
       ON CONFLICT (secret_id, viewer_id) DO NOTHING
       RETURNING *`,
      [params.secretId, params.viewerId, params.dmChannelId, params.dmTs, params.fileDmTs ?? null, params.fileUploadId ?? null, params.deleteAt],
    )
    if (result.rows.length === 0) {
      return { created: false, view: null }
    }
    return { created: true, view: result.rows[0] as ViewRow }
  },

  getViewById: async (viewId: string): Promise<ViewRow | null> => {
    const result = await pool.query(
      'SELECT * FROM views WHERE id = $1',
      [viewId],
    )
    return (result.rows[0] ?? null) as ViewRow | null
  },

  getView: async (secretId: string, viewerId: string): Promise<ViewRow | null> => {
    const result = await pool.query(
      'SELECT * FROM views WHERE secret_id = $1 AND viewer_id = $2',
      [secretId, viewerId],
    )
    return (result.rows[0] ?? null) as ViewRow | null
  },

  // Re-open a previously hidden/deleted view within its original delete_at
  // window - delete_at is NOT extended, the viewing window is fixed from the
  // first view.
  reopenView: async (viewId: string, dmChannelId: string, dmTs: string | null, fileDmTs?: string | null, fileUploadId?: string | null): Promise<void> => {
    await pool.query(
      "UPDATE views SET dm_channel_id = $1, dm_ts = $2, file_dm_ts = $3, file_upload_id = $4, status = 'delivered' WHERE id = $5",
      [dmChannelId, dmTs, fileDmTs ?? null, fileUploadId ?? null, viewId],
    )
  },

  getViewsBySecretId: async (secretId: string): Promise<ViewRow[]> => {
    const result = await pool.query(
      'SELECT * FROM views WHERE secret_id = $1 ORDER BY delivered_at DESC',
      [secretId],
    )
    return result.rows as ViewRow[]
  },

  markViewAsDeleted: async (viewId: string): Promise<void> => {
    await pool.query(
      "UPDATE views SET status = 'deleted' WHERE id = $1",
      [viewId],
    )
  },

  getDeliveredViewsDueForDeletion: async (): Promise<ViewRow[]> => {
    const result = await pool.query(
      `SELECT * FROM views
       WHERE status = 'delivered' AND delete_at <= now()`,
    )
    return result.rows as ViewRow[]
  },

  getDeliveredViewsForSecret: async (secretId: string): Promise<ViewRow[]> => {
    const result = await pool.query(
      `SELECT * FROM views
       WHERE secret_id = $1 AND status = 'delivered'`,
      [secretId],
    )
    return result.rows as ViewRow[]
  },

  deleteViewsForSecret: async (secretId: string): Promise<void> => {
    await pool.query('DELETE FROM views WHERE secret_id = $1', [secretId])
  },
  }

  return client
}

export type ViewsRepo = ReturnType<typeof createClient>
