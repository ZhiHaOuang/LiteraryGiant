import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import React from 'react'
import jsxRuntime from 'react/jsx-runtime'

for (const id of ['lg-dashboard', 'lg-brand', 'lg-reading-review', 'lg-library', 'lg-memory', 'lg-planning', 'lg-workflows', 'lg-author', 'lg-director', 'lg-impact', 'lg-export']) {
  test(`${id}: classic script registers lazy DSH factory and UI slots`, async () => {
    let registration
    const code = await readFile(new URL(`../${id}/client.js`, import.meta.url), 'utf8')
    const document = Object.assign(new EventTarget(), {
      createElement: () => ({remove() {}}),
      head: {appendChild() {}},
      body: {setAttribute() {}, removeAttribute() {}},
    })
    runInNewContext(code, { document, queueMicrotask, window: { __ModuleLoader__: { load(value) { registration = value } } } })
    assert.equal(registration.id, id)
    const plugin = registration.factory(name => {
      if(name==='@deepseek-ai/dsh-client-ui-primitives') return {}
      if(name==='react/jsx-runtime') return jsxRuntime
      assert.equal(name, 'react')
      return React
    })
    assert.equal(typeof plugin.apply, 'function')
    assert.ok(plugin.inject?.includes('slots'), 'declare the Cordis slots service before registering UI')
    const slots = [], services=new Map(), dependencies=[]
    const hiddenPanels=[]
    let activePanel
    let activeOptions
    const layout = { selectPanel: (id, options) => { activePanel = id; activeOptions = options } }
    plugin.apply({
      effect: fn => fn(),
      layout,
      contextMenus: {register: () => () => {}},
      provide: (key, value) => services.set(key, value),
      inject: (keys,fn) => {
        dependencies.push(Array.from(keys))
        if(keys.includes('sidebarPanels')){fn({sidebarPanels:{setPinned:(id,pinned)=>hiddenPanels.push([id,pinned])}});return}
        if(keys.includes('contextMenus')||keys.includes('workspaces'))return
        assert.deepEqual(Array.from(keys),['layout'])
        fn({layout, provide:(key,value)=>services.set(key,value)})
      },
      locale: { register: () => () => {}, bind: () => key => key },
      slots: { inject: (name, fn) => {
        const result = fn()
        if (result?.next) [...result]
      }, register: config => { slots.push(config); return () => {} } },
    })
    assert.ok(slots.some(slot => slot.name === (id === 'lg-brand' ? 'sidebar.brand.name' : 'main')))
    if(id==='lg-dashboard'){
      assert.ok(plugin.inject.includes('layout'))
      assert.deepEqual(dependencies,[], 'Dashboard must not install workspace handlers or styles')
      assert.deepEqual(slots.map(slot=>slot.name).sort(),['main','settings.onboarding','sidebar.panellist'])
      const navigation=services.get('literaryDashboard')
      navigation.openBook('/synthetic', 2)
      assert.equal(activePanel,'lg-dashboard')
      assert.equal(activeOptions.scope, 'pane')
      assert.equal(activeOptions.key, '/synthetic')
      assert.equal(activeOptions.target.path, '/synthetic')
      assert.equal(activeOptions.target.chapter, 2)
      activePanel=undefined
      navigation.openGlobal()
      assert.equal(activePanel,'lg-dashboard')
      assert.equal(activeOptions.scope, 'pane')
      assert.equal(activeOptions.key, 'default')
    }
    if(id==='lg-brand'){
      assert.ok(dependencies.some(keys=>keys.includes('literaryDashboard')&&keys.includes('workspaces')))
      for(const id of ['lg-director','lg-author','lg-impact','lg-export'])assert.ok(hiddenPanels.some(([name,pinned])=>name===id&&!pinned))
      assert.ok(!hiddenPanels.some(([id])=>['lg-dashboard','lg-reading-review'].includes(id)))
    }
    if (id==='lg-reading-review') {
      services.get('literaryReading').openVersion('/synthetic',2,8)
      assert.equal(activePanel,'lg-reading-review')
    }
  })
}
