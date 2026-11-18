/** Fence queued work before shutdown, while callers await operations already running. */
export function activityGate() {
  let stopped = false
  const cancelled = new Error('Panel collection stopped')
  return {
    async run<T>(operation: () => T | Promise<T>): Promise<T> {
      if (stopped) throw cancelled
      return operation()
    },
    stop(): void { stopped = true },
    cancelled(error: unknown): boolean { return error === cancelled },
  }
}
