import type { FeatureManifest } from '../../core/feature'

export default {
  id: 'heroMenu',
  order: 100,
  reads: ['composer'],
  contracts: ['shell.menu'],
  ungated: '跟随输入框改造的首页范围',
  stylesheets: [{ file: 'hero-menu.css', rank: 280, gate: true }],
  cases: ['popovers']
} satisfies FeatureManifest
