import type { FeatureManifest } from '../../core/feature'

export default {
  id: 'peakrate',
  order: 75,
  pref: 'peakrate',
  stylesheets: [{ file: 'peakrate.css', rank: 265 }],
  settingsRows: [{
    // The meter draws into the picker's own rows, so it belongs to that row.
    tab: 'composer',
    rank: 45,
    pref: 'peakrate',
    parent: 'modelPicker',
    title: 'peakrateTitle',
    desc: 'peakrateDesc',
  }],
  cases: ['composer', 'settings', 'model-meter'],
  contracts: []
} satisfies FeatureManifest
