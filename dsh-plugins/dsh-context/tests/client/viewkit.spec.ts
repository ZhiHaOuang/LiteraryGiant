import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { act, createElement as h } from 'react'
import { DICT_EN } from '../../src/client/i18n'
import { makeViewKit } from '../../src/client/viewkit'
import type { ContextEventRecord } from '../../src/shared/types'
import { makeKit, makeTranslate, mount, text } from './helpers/kit'

describe('makeViewKit', () => {
  test('catLabel maps through the dictionary', () => {
    const kit = makeKit()
    assert.equal(kit.catLabel('system'), DICT_EN['cat.system'])
    assert.equal(kit.catLabel('tool'), DICT_EN['cat.tool'])
  })

  test('eventLabel delegates to makeEventText (compaction with a count)', () => {
    const kit = makeKit()
    const ev: ContextEventRecord = { seq: 1, time: 1000, kind: 'compaction', count: 3, turn: 2, step: 4 }
    assert.equal(kit.eventLabel(ev), DICT_EN['ev.compaction'].replace('{n}', '3'))
  })

  test('eventAt is null for an event without a turn/step anchor', () => {
    const kit = makeKit()
    const ev: ContextEventRecord = { seq: 2, time: 1000, kind: 'inject', form: 'notice' }
    assert.equal(kit.eventAt(ev), null)
  })

  test('useLocaleTick is inert without a locale service and re-renders on a locale change with one', async () => {
    const plain = makeKit()
    const Plain = (): ReturnType<typeof h> => {
      plain.useLocaleTick()
      return h('span', null, plain.t('files.title'))
    }
    const m = await mount(h(Plain))
    assert.ok(text(m.container).includes('File Activity'))
    await m.unmount()

    let active = 'en'
    const listeners = new Set<() => void>()
    const locale = {
      register: () => () => {},
      bind: () => makeTranslate('en') as never,
      getLocale: () => ({ active }),
      subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    }
    const dicts: Record<'en' | 'zh', Record<string, string>> = { en: { 'files.title': 'File Activity' }, zh: { 'files.title': '文件活动' } }
    const liveT = (key: string, params?: Record<string, string | number>): string => {
      let s = dicts[active as 'en' | 'zh'][key] ?? key
      if (params) for (const k in params) s = s.replace('{' + k + '}', String(params[k]))
      return s
    }
    const kit = makeViewKit(liveT, locale as never)
    const Live = (): ReturnType<typeof h> => {
      kit.useLocaleTick()
      return h('span', null, kit.t('files.title'))
    }
    const m2 = await mount(h(Live))
    assert.ok(text(m2.container).includes('File Activity'))
    active = 'zh'
    await act(async () => { for (const fn of listeners) fn() })
    assert.ok(text(m2.container).includes('文件活动'))
    await m2.unmount()

    active = 'en'
    const bare = { subscribe: (_fn: () => void) => () => {} }
    const bareKit = makeViewKit(liveT, bare as never)
    const Bare = (): ReturnType<typeof h> => {
      bareKit.useLocaleTick()
      return h('span', null, bareKit.t('files.title'))
    }
    const m3 = await mount(h(Bare))
    assert.ok(text(m3.container).includes('File Activity'))
    await m3.unmount()
  })
})
