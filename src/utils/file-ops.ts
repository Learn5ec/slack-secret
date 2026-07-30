import fs from 'fs'
import path from 'path'
import { logger } from './logger'

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(process.cwd(), 'encrypted-storage')

export function getStorageDir(): string {
  return STORAGE_DIR
}

export async function ensureStorageDir(): Promise<void> {
  try {
    await fs.promises.mkdir(STORAGE_DIR, { recursive: true })
    logger.info({ dir: STORAGE_DIR }, 'Storage directory ensured')
  } catch (err) {
    logger.error({ err, dir: STORAGE_DIR }, 'Failed to ensure storage directory')
    throw err
  }
}

export async function readLocalFile(filePath: string): Promise<Buffer> {
  try {
    const data = await fs.promises.readFile(filePath)
    return data
  } catch (err) {
    logger.error({ err, filePath }, 'Failed to read local file')
    throw err
  }
}

export async function writeLocalFile(filePath: string, data: Buffer): Promise<void> {
  try {
    const dir = path.dirname(filePath)
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(filePath, data)
    logger.info({ filePath, size: data.length }, 'Local file written')
  } catch (err) {
    logger.error({ err, filePath }, 'Failed to write local file')
    throw err
  }
}

export async function deleteLocalFile(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath)
    logger.info({ filePath }, 'Local file deleted')
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to delete local file')
    // Don't throw - file might already be deleted
  }
}

export function generateFilePath(fileName: string): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(7)
  const ext = path.extname(fileName) || '.bin'
  const baseName = path.basename(fileName, ext)
  return path.join(STORAGE_DIR, `${timestamp}-${random}-${baseName}${ext}`)
}
