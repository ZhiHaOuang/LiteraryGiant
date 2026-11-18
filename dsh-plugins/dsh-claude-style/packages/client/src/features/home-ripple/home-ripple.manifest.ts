import type { FeatureManifest } from '../../core/feature'

export default {
  id: 'homeRipple',
  order: 35,
  contracts: ['shell.dark-theme'],
  pref: 'homeRipple',
  stylesheets: [{ file: 'home-ripple.css', rank: 325 }],
  settingsRows: [{
    tab: 'appearance',
    rank: 26,
    pref: 'homeRipple',
    parent: 'homeLayout',
    title: 'homeRippleTitle',
    desc: 'homeRippleDesc',
    experimental: true,
  }],
  cases: ['hero']
} satisfies FeatureManifest
