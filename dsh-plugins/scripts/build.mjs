import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
if (!process.argv[2] || process.argv[2] === 'lg-agent-teams') {
  await build({absWorkingDir:root, entryPoints:['lg-agent-teams/src/context-pricing-entry.js'],
    outfile:'lg-agent-teams/src/context-pricing.js', bundle:true, format:'esm', platform:'node', target:'es2022',
    banner:{js:'// Generated from dsh-context 0.82.1. See ../NOTICE and ../LICENSE-dsh-context.'}, legalComments:'eof'})
}
for (const [id, source] of [['lg-storydata', 'client.jsx'], ['lg-dashboard', 'client.jsx'], ['lg-agents','client.jsx'], ['lg-brand', 'client.js'], ['lg-reading-review', 'client.jsx'], ['lg-library', 'client.jsx'], ['lg-memory', 'client.jsx'], ['lg-planning', 'client.jsx'], ['lg-workflows', 'client.jsx'], ['lg-author', 'client.jsx'], ['lg-director', 'client.jsx'], ['lg-impact', 'client.jsx'], ['lg-export', 'client.jsx']]) {
  if (process.argv[2] && process.argv[2] !== id) continue
  const plugins = id === 'lg-dashboard' ? [{
    name: 'lg-offline-prices',
    setup(build) {
      build.onResolve({filter:/^lg-offline-prices$/},()=>({path:'prices',namespace:'lg-prices'}))
      build.onLoad({filter:/.*/,namespace:'lg-prices'},async()=>{
        const {providers,generatedAt}=await import('@opencode-ai/models/snapshot')
        const compact=Object.fromEntries(Object.entries(providers).map(([id,provider])=>[id,{models:
          Object.fromEntries(Object.entries(provider.models).filter(([,model])=>model.cost).map(([id,model])=>
            [id,{cost:model.cost,canonical_model_id:model.canonical_model_id}]))}]))
        return {contents:JSON.stringify({generatedAt,providers:compact}),loader:'json'}
      })
    },
  }] : []
  await build({ plugins, absWorkingDir: root, nodePaths: [root + 'node_modules'], entryPoints: [`${id}/src/${source}`],
    outfile: `${id}/client.js`, bundle: true, format: 'cjs', platform: 'browser',
    target: 'es2022', external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'], loader: { '.css': 'text', '.png':'dataurl' },
    banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;` },
    footer: { js: 'return module.exports; } });' }, legalComments: 'eof' })
}
