import type { FeatureManifest } from '../../core/feature'

export default {
  id: 'turnNav',
  order: 180,
  load: 'deferred',
  contracts: ['boot.peer-sheet', 'chat.scroller', 'chat.turn-attribute', 'conversation.session', 'conversation.session-attribute', 'shell.foreground', 'turn.rail', 'turn.rail-current', 'turn.rail-inset', 'turn.rail-mark', 'turn.rail-pitch', 'turn.rail-scroller'],
  pref: 'turnNav',
  stylesheets: [{ file: 'turn-nav.css', rank: 150 }],
  settingsRows: [{
    tab: 'conversation',
    rank: 20,
    pref: 'turnNav',
    title: 'turnNavTitle',
  }],
  cases: ['turn-nav']
} satisfies FeatureManifest
