import { profileCommand } from '../../src/profile-install.js'
import { ensureSessionTemp, sessionTempDir } from '../../src/session-temp.js'
const directory: string = sessionTempDir('session-id')
const result = ensureSessionTemp(directory)
if (!result.ok) { const message: string = result.message; void message }
else {
  // @ts-expect-error Successful temp creation does not invent an error message.
  void result.message
}
const invoke: () => number = () => profileCommand('install', { profile: 'tui', dryRun: true })
// @ts-expect-error Only the profile CLI's three operations are supported.
profileCommand('overwrite', { profile: 'tui' })
// @ts-expect-error Dry-run selection is a boolean, not a truthy string.
profileCommand('install', { profile: 'tui', dryRun: 'yes' })
// @ts-expect-error The session identity is an authoritative string.
sessionTempDir({ id: 'session-id' })
// @ts-expect-error The chosen temp directory is a path string.
ensureSessionTemp(42)
void invoke
