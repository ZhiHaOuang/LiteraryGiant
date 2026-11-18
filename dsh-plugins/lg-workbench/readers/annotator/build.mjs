import {readFileSync,writeFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
const dshRoot=process.env.LG_DSH_ROOT,pluginsRoot=process.env.LG_PLUGINS_ROOT
if(!dshRoot||!pluginsRoot)throw Error('LG_DSH_ROOT and LG_PLUGINS_ROOT must point to the existing DSH and dsh-plugins directories')
const require=createRequire(resolve(pluginsRoot,'package.json'))
const {build}=require('esbuild')
const react=resolve(dshRoot,'node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')
const reactDOM=resolve(dshRoot,'node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/index.js')
const reactClient=resolve(dshRoot,'node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js')
const names=['styles','store','parser','selection','panel','files','documents','toolbar','blocks','viewer','sidebar']
let source=names.map(name=>name==='toolbar'?readFileSync('readonly-toolbar.js','utf8'):readFileSync('upstream/lib/src/'+name+'.js','utf8')).join('\n')
// These actions produce an excerpt in the LG parent, never a conversation draft.
source=source.replaceAll('全部写入草稿','整理全部批注').replaceAll('所选写入草稿','整理所选批注').replaceAll('写入草稿','整理摘录').replaceAll('写入对话框草稿','生成可复制摘录').replaceAll('回车即可发送','不会自动发送').replaceAll('发送这条到对话框','整理这条批注').replaceAll('发送所选项到对话框','整理所选批注')
const code=`import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDOM)};import {createRoot} from ${JSON.stringify(reactClient)};\n${source}\n${readFileSync('bridge.js','utf8')}`
const result=await build({stdin:{contents:code,resolveDir:process.cwd(),sourcefile:'annotator-trial.js'},bundle:true,minify:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'},legalComments:'inline'})
const css=readFileSync('frame.css','utf8')
writeFileSync('preview.html',`<!doctype html><html lang="zh"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body><div id="root"></div><script>${result.outputFiles[0].text.replaceAll('</script','<\\/script')}</script></body></html>`)
console.log('preview.html bytes',readFileSync('preview.html').length)
