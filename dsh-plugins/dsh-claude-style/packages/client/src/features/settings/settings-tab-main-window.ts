import * as React from 'react'
import { COMPOSER_SCOPE_OFF } from '../../constants'
import { copy } from './copy'
import type { SettingsGroup, SettingsRow, SettingsTab, SettingsView } from './settings-controls'

/**
 * The settings page's Main window tab: the conversation side, the composer's
 * controls, and the context and cost figures the composer carries, each under
 * its own label.
 *
 * The rows of every group are the features' own, placed here by their manifests
 * (D76), which name the group they stand in: the message navigator, the column's
 * width, the Chat / Trajectory strip and the Windows title-bar band first; the
 * restyle's scope with its bottom gap, the permission control and the model
 * picker with the rows that hang off it next; the context meter, the statistics'
 * place and the billing last. The labels are this page's own, and so is the
 * quick-provider row, whose popover is imperative where this page is React
 * (settings.ts).
 */
export function createSettingsMainWindowTab(): SettingsTab {
  /** What the quick-provider trigger reads: how many, or nothing chosen. */
  function quickSummary(chosen: string[]) {
    if (chosen.length === 0) return copy('quickNone')
    return copy('quickCount', { count: chosen.length })
  }

  /**
   * The composer group's own row. The picker and the permission control are
   * drawn into the restyled composer, so this row waits with them for the
   * restyle (the manifests' `requires`).
   */
  function composerRows(view: SettingsView): SettingsRow[] {
    const prefs = view.prefs
    const write = view.write
    const pickerOn = prefs.modelPicker && prefs.composerScope !== COMPOSER_SCOPE_OFF
    const quickTrigger = view.quickTrigger
    return [
      {
        rank: 40,
        node: view.controls.subRow(
          'quickProviders',
          copy('quickTitle'),
          copy('quickDesc'),
          React.createElement('button', {
            type: 'button',
            ref: quickTrigger,
            className: 'dsh-claude-settings-picker',
            disabled: !pickerOn,
            'aria-haspopup': 'menu',
            'aria-expanded': 'false',
            onClick() {
              const api = view.quickProviderApi()
              if (api === null || quickTrigger.current === null) return
              api.toggle(quickTrigger.current, next => { write({ quickProviders: next }) })
            },
          }, quickSummary(prefs.quickProviders)),
          pickerOn,
        ),
      },
    ]
  }

  function groups(_view: SettingsView): SettingsGroup[] {
    return [
      { id: 'conversation', label: () => copy('groupConversation') },
      { id: 'composer', label: () => copy('groupComposer'), rows: composerRows },
      { id: 'statistics', label: () => copy('groupStatistics') },
    ]
  }

  return { id: 'main-window', label: () => copy('tabMainWindow'), groups }
}
