export type DisplayName = { userId: string; displayName: string }

export class UserIdCache {
  private cache = new Map<string, string>()
  private pending: Map<string, Promise<string>> = new Map()

  constructor(
    private fetchDisplayName: (userId: string) => Promise<string>,
  ) {}

  async getDisplayName(userId: string): Promise<string> {
    const cached = this.cache.get(userId)
    if (cached) return cached

    const pending = this.pending.get(userId)
    if (pending) return pending

    const promise = this.fetchDisplayName(userId).then((name) => {
      this.cache.set(userId, name)
      this.pending.delete(userId)
      return name
    })

    this.pending.set(userId, promise)
    return promise
  }
}
