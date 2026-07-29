import sodium from 'libsodium-wrappers'
import { ALGORITHM, NONCE_LENGTH, DATA_KEY_LENGTH, ENVELOPE_VERSION } from './constants'
import { decryptDataKey, encryptDataKey } from './master'

export type SecretEnvelope = {
  version: typeof ENVELOPE_VERSION
  algorithm: typeof ALGORITHM
  nonce: string
  ciphertext: string
  encryptedDataKey: string
}

export async function encryptSecret(
  plaintext: string,
  masterKey: Buffer,
): Promise<SecretEnvelope> {
  await sodium.ready

  // Generate random data key
  const dataKey = Buffer.from(sodium.randombytes_buf(DATA_KEY_LENGTH))

  // Generate random nonce
  const nonce = Buffer.from(sodium.randombytes_buf(NONCE_LENGTH))

  // Encrypt plaintext with data key
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, dataKey)

  // Encrypt data key with master key
  const encryptedDataKey = encryptDataKey(dataKey, masterKey)

  return {
    version: ENVELOPE_VERSION,
    algorithm: ALGORITHM,
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
    encryptedDataKey: sodium.to_base64(encryptedDataKey, sodium.base64_variants.ORIGINAL),
  }
}

export async function decryptSecret(
  envelope: SecretEnvelope,
  masterKey: Buffer,
): Promise<string> {
  await sodium.ready

  // Decrypt data key with master key
  const dataKey = decryptDataKey(envelope.encryptedDataKey, masterKey)

  // Decode nonce and ciphertext from base64
  const nonce = Buffer.from(sodium.from_base64(envelope.nonce, sodium.base64_variants.ORIGINAL))
  const ciphertext = Buffer.from(sodium.from_base64(envelope.ciphertext, sodium.base64_variants.ORIGINAL))

  // Decrypt ciphertext with data key
  const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, dataKey)

  return sodium.to_string(plaintext)
}
