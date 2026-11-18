import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import type { makeUpdatePill as makeUpdatePillFn } from '../../../src/client/components/updatePill'
import { flush, makeKit, mount, query, queryAll } from '../helpers/kit'

async function loadUpdatePill(version: string): Promise<ReturnType<typeof makeUpdatePillFn>> {
  vi.resetModules()
  ;(globalThis as Record<string, unknown>).__DSH_CTX_VERSION__ = version
  await import('../../../src/client/latestVersion')
  const mod = await import('../../../src/client/components/updatePill')
  return mod.makeUpdatePill(makeKit())
}

function stubRegistry(): void {
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ version: '1.1.0' }) }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as Record<string, unknown>).__DSH_CTX_VERSION__
})

describe('UpdatePill', () => {
  test('a newer version paints the capsule linking the release notes', async () => {
    stubRegistry()
    const UpdatePill = await loadUpdatePill('1.0.0')
    const m = await mount(h(UpdatePill, {}))
    await flush()
    const pill = query(m.container, '.lc-ov-update')
    assert.equal(pill.getAttribute('href'), 'https://github.com/bowenliang123/dsh-context/releases/latest')
    assert.equal(pill.getAttribute('target'), '_blank')
    assert.equal(pill.getAttribute('rel'), 'noreferrer')
    assert.equal(query(pill, '.lc-ov-update-label').textContent, 'Update')
    assert.equal(query(pill, '.lc-ov-update-version').textContent, '↑ v1.1.0')
    assert.equal(pill.getAttribute('data-lc-tip'), 'Update v1.1.0 is available — click for the release notes')
    assert.equal(pill.getAttribute('data-lc-tip-side'), 'bottom')
    assert.equal(pill.getAttribute('aria-label'), pill.getAttribute('data-lc-tip'))
    await m.unmount()
  })

  test('the build being current leaves the head unpainted', async () => {
    stubRegistry()
    const UpdatePill = await loadUpdatePill('1.1.0')
    const m = await mount(h(UpdatePill, {}))
    await flush()
    assert.equal(queryAll(m.container, '.lc-ov-update').length, 0)
    await m.unmount()
  })
})