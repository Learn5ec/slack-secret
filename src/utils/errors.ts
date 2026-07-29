export class SecretNotFoundError extends Error {
  constructor(secretId: string) {
    super(`Secret not found: ${secretId}`)
    this.name = 'SecretNotFoundError'
  }
}

export class SecretAlreadyViewedError extends Error {
  constructor(secretId: string, viewerId: string) {
    super(`Secret ${secretId} already viewed by ${viewerId}`)
    this.name = 'SecretAlreadyViewedError'
  }
}

export class UnauthorizedError extends Error {
  constructor(message = 'You are not authorized to perform this action') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export class SecretExpiredError extends Error {
  constructor(secretId: string) {
    super(`Secret ${secretId} has expired`)
    this.name = 'SecretExpiredError'
  }
}

export class SecretCancelledError extends Error {
  constructor(secretId: string) {
    super(`Secret ${secretId} has been cancelled`)
    this.name = 'SecretCancelledError'
  }
}

export class SecretAlreadyConsumedError extends Error {
  constructor(secretId: string) {
    super(`Secret ${secretId} has already been consumed (single-viewer mode)`)
    this.name = 'SecretAlreadyConsumedError'
  }
}
