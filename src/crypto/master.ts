import * as fs from 'fs'
import sodium from 'libsodium-wrappers'
import { loadConfig } from '../config'
import { DATA_KEY_LENGTH } from './constants'

let cachedMasterKey: Buffer | null = null

export async function getMasterKey(): Promise<Buffer> {
  if (cachedMasterKey) return cachedMasterKey

  const config = loadConfig()
  const keyPath = config.MASTER_KEY_FILE

  // Read the raw master key file
  const masterKey = fs.readFileSync(keyPath)

  if (masterKey.length !== DATA_KEY_LENGTH) {
    throw new Error(
      `Master key file has invalid size: ${masterKey.length} bytes (expected ${DATA_KEY_LENGTH})`
    )
  }

  cachedMasterKey = masterKey
  return masterKey
}

export function encryptDataKey(dataKey: Buffer, masterKey: Buffer): Buffer {
  // Use sodium's secretbox with a random nonce
  const nonce = Buffer.from(sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES))
  const key = sodium.crypto_generichash(sodium.crypto_secretbox_KEYBYTES, masterKey)

  const encrypted = sodium.crypto_secretbox_easy(dataKey, nonce, key)

  // Prepend nonce to ciphertext so we can extract it during decryption
  const result = Buffer.alloc(nonce.length + encrypted.length)
  nonce.copy(result)
  Buffer.from(encrypted).copy(result, nonce.length)

  return result
}

export function decryptDataKey(encryptedDataKeyB64: string, masterKey: Buffer): Buffer {
  const encryptedDataKey = Buffer.from(
    sodium.from_base64(encryptedDataKeyB64, sodium.base64_variants.ORIGINAL),
  )

  const key = sodium.crypto_generichash(sodium.crypto_secretbox_KEYBYTES, masterKey)

  // crypto_secretbox_easy prepends the nonce to the ciphertext, so extract it
  const nonce = Buffer.from(encryptedDataKey.subarray(0, sodium.crypto_secretbox_NONCEBYTES))
  const ciphertext = Buffer.from(encryptedDataKey.subarray(sodium.crypto_secretbox_NONCEBYTES))

  const decrypted = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key)
  return Buffer.from(decrypted)
}
