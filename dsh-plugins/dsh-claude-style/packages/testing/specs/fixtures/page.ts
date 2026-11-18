import { afterEach } from 'vitest'

/**
 * The page a spec mounts host markup on, put back after each test: the
 * disposals a spec pushed run first and the body is then emptied, so one
 * test's marks are never read by the next.
 *
 * Called at the top of a spec file, during collection, so the hook lands on
 * that file's own suite.
 *
 * @returns the list the spec pushes its disposals onto.
 */
export function pageCleanups() {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
    document.body.replaceChildren()
  })
  return cleanups
}
