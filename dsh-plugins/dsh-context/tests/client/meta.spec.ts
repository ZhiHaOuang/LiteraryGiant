import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'

const globals = globalThis as Record<string, unknown>

afterEach(() => {
  delete globals.__DSH_CTX_VERSION__
  delete globals.__DSH_CTX_REPO__
  vi.resetModules()
})

async function importMeta(): Promise<typeof import('../../src/client/meta')> {
  vi.resetModules()
  return await import('../../src/client/meta')
}

describe('meta', () => {
  test('without build defines the dev/test fallbacks apply', async () => {
    const meta = await importMeta()
    assert.equal(meta.PLUGIN_NAME, 'dsh-context')
    assert.equal(meta.PLUGIN_VERSION, '0.0.0-dev')
    assert.equal(meta.PLUGIN_REPO, 'https://github.com/bowenliang123/dsh-context')
    assert.equal(meta.PLUGIN_REPO_SHORT, 'bowenliang123/dsh-context')
  })

  test('build defines win: the short form strips a github prefix and keeps any other URL whole', async () => {
    globals.__DSH_CTX_VERSION__ = '9.9.9'
    let meta = await importMeta()
    assert.equal(meta.PLUGIN_VERSION, '9.9.9')
    assert.equal(meta.PLUGIN_REPO, 'https://github.com/bowenliang123/dsh-context')

    globals.__DSH_CTX_REPO__ = 'https://github.com/acme/widget'
    meta = await importMeta()
    assert.equal(meta.PLUGIN_REPO, 'https://github.com/acme/widget')
    assert.equal(meta.PLUGIN_REPO_SHORT, 'acme/widget')

    globals.__DSH_CTX_REPO__ = 'http://git.example.com/acme/widget'
    meta = await importMeta()
    assert.equal(meta.PLUGIN_REPO_SHORT, 'http://git.example.com/acme/widget')
  })
})
