import { upgradeHostPwsh } from '../shells/pwsh-upgrade.js'

export async function commandUpgradeHostPwsh({ yes = false, dryRun = false }: { yes?: boolean; dryRun?: boolean } = {}): Promise<number> {
  const controller = new AbortController()
  const cancel = (): void => controller.abort(new Error('Operator cancelled the PowerShell upgrade'))
  process.once('SIGINT', cancel)
  try {
    const result = await upgradeHostPwsh({ execute: yes, dryRun, signal: controller.signal })
    console.log(JSON.stringify(result, null, 2))
    if (result.status === 'preview') console.log('Pass --yes to run this standard host installation. WinGet retains its own installer and agreement prompts.')
    if (result.status === 'cancelled') console.log('Check the standard PowerShell installation before retrying; cancellation may not undo an installer already started.')
    return ['preview', 'completed', 'no-update'].includes(result.status) ? 0 : result.status === 'cancelled' ? 130 : 1
  } finally { process.removeListener('SIGINT', cancel) }
}
