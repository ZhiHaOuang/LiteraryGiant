/** Preserve the public configuration error identity across typed validators. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(`dsh-ops config: ${message}`)
    this.name = 'ConfigError'
  }
}
