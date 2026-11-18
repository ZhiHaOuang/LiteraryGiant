import type { FeatureManifest } from '../../core/feature'

export default {
  id: 'sessionTitle',
  order: 258,
  ungated: '会话标题上的一次点击：宿主画出标题的地方才有这个字段，别的页面装不上什么',
  contracts: [],
  stylesheets: [{ file: 'session-title.css', rank: 79 }],
  cases: []
} satisfies FeatureManifest
