import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  canOpenPathsOf,
  openChildAsideVia,
  openPathVia,
  openPluginSettings,
  openResourceVia,
  openSessionVia,
  subagentChatAddressOf,
} from '../../src/client/services'
import type { ClientCtx } from '../../src/client/services'

const ctxWith = (services: Record<string, unknown>): ClientCtx =>
  ({ get: (name: string) => services[name] }) as unknown as ClientCtx

describe('canOpenPathsOf / openPathVia', () => {
  const rpcConn = (routes: Record<string, () => unknown>, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    isLoopback: true,
    rpc: { call: (channel: string, endpoint: string) => Promise.resolve(routes[endpoint]?.()) },
    ...over,
  })
  const openable = (): Record<string, unknown> =>
    rpcConn({ 'session/canOpenWorkspacePath': () => ({ ok: true, value: true }) })

  test('the capability remote gates the opener behind the loopback fact; hostile connections and failed transports resolve false', async () => {
    assert.equal(await canOpenPathsOf(ctxWith({ connection: openable() })), true)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: rpcConn({ 'session/canOpenWorkspacePath': () => ({ ok: true, value: false }) }) })), false)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: rpcConn({ 'session/canOpenWorkspacePath': () => ({ ok: false }) }) })), false)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: rpcConn({ 'session/canOpenWorkspacePath': () => 'garbage' }) })), false)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: { isLoopback: false, rpc: openable().rpc } })), false)
    assert.equal(await canOpenPathsOf(ctxWith({})), false)
    const throwProp = (): never => { throw new Error('boom') }
    assert.equal(await canOpenPathsOf({ get: throwProp } as unknown as ClientCtx), false)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: { isLoopback: true, rpc: { get call(): unknown { return throwProp() } } } })), false)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: { get isLoopback(): boolean { return throwProp() }, rpc: openable().rpc } })), false)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: { isLoopback: true, rpc: { call: 7 } } })), false)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: { isLoopback: true, rpc: { call: () => Promise.reject(new Error('offline')) } } })), false)
  })

  test('openPathVia returns a fire-and-forget caller that forwards the path and swallows failures', () => {
    const open = openPathVia(ctxWith({ connection: { rpc: { call: () => Promise.reject(new Error('no desktop')) } } }))
    assert.ok(open !== undefined)
    open('/repo/a.ts')
    const syncThrow = openPathVia(ctxWith({ connection: { rpc: { call: () => { throw new Error('sync') } } } }))
    syncThrow!('/repo/a.ts')
    assert.equal(openPathVia(ctxWith({})), undefined)
    const calls: { channel: string; endpoint: string; payload: unknown }[] = []
    const forwarding = openPathVia(ctxWith({
      connection: {
        rpc: {
          call: (channel: string, endpoint: string, payload: unknown) => {
            calls.push({ channel, endpoint, payload })
            return Promise.resolve({ ok: true, value: { opened: true } })
          },
        },
      },
    }))
    forwarding!('/repo/a.ts')
    assert.deepEqual(calls, [{ channel: '/api', endpoint: 'session/openWorkspacePath', payload: { args: { request: { path: '/repo/a.ts' } } } }])
  })
})

describe('openResourceVia', () => {

  test('forwards the address and options to the Sidebar face and reports the open', () => {
    const calls: { address: string; options: unknown }[] = []
    const open = openResourceVia(ctxWith({
      sidebarRight: { openResource: (address: string, options?: unknown) => { calls.push({ address, options }) } },
    }))
    assert.ok(open !== undefined)
    assert.equal(open('dsh-resource://file/session/s1/a.ts', { kind: 'subagentchat', preferNewPane: true }), true)
    assert.deepEqual(calls, [{ address: 'dsh-resource://file/session/s1/a.ts', options: { kind: 'subagentchat', preferNewPane: true } }])
  })

  test('an absent or hostile face yields no opener at all', () => {
    assert.equal(openResourceVia(ctxWith({})), undefined)
    assert.equal(openResourceVia(ctxWith({ sidebarRight: null })), undefined)
    assert.equal(openResourceVia(ctxWith({ sidebarRight: {} })), undefined)
    assert.equal(openResourceVia(ctxWith({ sidebarRight: { openResource: 7 } })), undefined)
    assert.equal(openResourceVia({ get: () => { throw new Error('boom') } } as unknown as ClientCtx), undefined)
  })

  test('a refusal reports false instead of throwing, and the face is re-proved per call', () => {
    const open = openResourceVia(ctxWith({ sidebarRight: { openResource: () => { throw new Error('no type claims it') } } }))
    assert.equal(open!('dsh-resource://file/session/s1/a.ts'), false)
    const services: Record<string, unknown> = { sidebarRight: { openResource: () => {} } }
    const proven = openResourceVia(ctxWith(services))
    assert.ok(proven !== undefined)
    services.sidebarRight = undefined
    assert.equal(proven('dsh-resource://file/session/s1/a.ts'), false, 'a revoked service refuses after the opener was built')
  })
})

describe('openSessionVia', () => {

  test('jumps through the view owner\'s own verb (issue #90), invoked bound to its service instance', () => {
    const opened: string[] = []
    openSessionVia(ctxWith({
      uiWorkspace: { openSession(id: string) { opened.push(id) } },
    }), 's2')
    assert.deepEqual(opened, ['s2'])
    let seen: unknown
    const face = {
      target: 's4',
      openSession(this: { target: string }, id: string) { seen = `${this.target}:${id}` },
    }
    openSessionVia(ctxWith({ uiWorkspace: face }), 's4')
    assert.equal(seen, 's4:s4')
  })

  test('a missing, verb-less, or hostile face never throws into the click handler', () => {
    for (const ctx of [
      ctxWith({}),
      ctxWith({ uiWorkspace: {} }),
      ctxWith({ uiWorkspace: { openSession: 7 } }),
      ctxWith({ uiWorkspace: { openSession: () => { throw new Error('boom') } } }),
      ctxWith({ uiWorkspace: { get openSession() { throw new Error('boom') } } }),
      { get: () => { throw new Error('boom') } } as unknown as ClientCtx,
    ]) openSessionVia(ctx, 's5')
  })
})

describe('openPluginSettings', () => {

  test('opens this bundle\'s page through the panel\'s own verb, bound to its service instance', () => {
    const opened: string[] = []
    openPluginSettings(ctxWith({ pluginNavigation: { openBundle: (name: string) => { opened.push(name) } } }))
    assert.deepEqual(opened, ['dsh-context'])
    let seen: unknown
    const face = {
      target: 'bundle',
      openBundle(this: { target: string }, name: string) { seen = `${this.target}:${name}` },
    }
    openPluginSettings(ctxWith({ pluginNavigation: face }))
    assert.equal(seen, 'bundle:dsh-context')
  })

  test('a shell without the Plugins panel module, a verb-less face, or a hostile face never throws', () => {
    for (const ctx of [
      ctxWith({}),
      ctxWith({ pluginNavigation: null }),
      ctxWith({ pluginNavigation: {} }),
      ctxWith({ pluginNavigation: { openBundle: 7 } }),
      ctxWith({ pluginNavigation: { openBundle: () => { throw new Error('boom') } } }),
      ctxWith({ pluginNavigation: { get openBundle() { throw new Error('boom') } } }),
      { get: () => { throw new Error('boom') } } as unknown as ClientCtx,
    ]) openPluginSettings(ctx)
  })
})

describe('openChildAsideVia', () => {

  test('the address mirrors the shipped catalog\'s canonical spelling', () => {
    assert.equal(
      subagentChatAddressOf({ parentSessionId: 'p1', childSessionId: 'c/1', mode: 'continuable' }),
      'dsh-resource://subagentchat/session/c%2F1?parent=p1&mode=continuable',
    )
  })

  test('opens the aside resource with the catalog\'s own options; a row without its projection rides the unknown mode', () => {
    const calls: { address: string; options: unknown }[] = []
    const ok = openChildAsideVia(ctxWith({
      sidebarRight: { openResource: (address: string, options?: unknown) => { calls.push({ address, options }) } },
    }), { parentSessionId: 'p1', childSessionId: 'c1', mode: 'one-shot' })
    assert.ok(ok)
    assert.equal(calls[0]?.address, 'dsh-resource://subagentchat/session/c1?parent=p1&mode=one-shot')
    assert.deepEqual(calls[0]?.options, { kind: 'subagentchat', preferNewPane: true })
    openChildAsideVia(ctxWith({
      sidebarRight: { openResource: (address: string, options?: unknown) => { calls.push({ address, options }) } },
    }), { parentSessionId: 'p1', childSessionId: 'c1' })
    assert.equal(calls[1]?.address, 'dsh-resource://subagentchat/session/c1?parent=p1&mode=unknown')
  })

  test('a parent-less address, an absent column, or an address no type claims reports false without throwing', () => {
    const opened: string[] = []
    assert.equal(
      openChildAsideVia(ctxWith({ sidebarRight: { openResource: (a: string) => { opened.push(a) } } }), { childSessionId: 'c1' }),
      false,
    )
    assert.deepEqual(opened, [])
    const address = { parentSessionId: 'p1', childSessionId: 'c1', mode: 'continuable' } as const
    assert.equal(openChildAsideVia(ctxWith({}), address), false)
    assert.equal(
      openChildAsideVia(ctxWith({ sidebarRight: { openResource: () => { throw new Error('no type claims it') } } }), address),
      false,
    )
  })
})
