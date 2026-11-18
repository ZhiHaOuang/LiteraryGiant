import type { FeatureManifest } from '../../core/feature'

export default {
  id: 'quickProviders',
  order: 110,
  reads: ['model'],
  contracts: [],
  ungated: '模型选择器的设置项，不在界面上出现',
  stylesheets: [],
  cases: ['settings']
} satisfies FeatureManifest
