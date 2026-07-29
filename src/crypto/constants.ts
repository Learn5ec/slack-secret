export const ALGORITHM = 'xsalsa20poly1305' as const
export const NONCE_LENGTH = 24 // bytes
export const DATA_KEY_LENGTH = 32 // 256 bits
export const ENVELOPE_VERSION = 1 as const
export const SECRET_EXPIRY_MS = 60 * 60 * 1000 // 1 hour
export const DELETE_AFTER_REVEAL_MS = 5 * 60 * 1000 // 5 minutes
