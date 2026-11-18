import {writeFile,readFile,mkdir} from 'node:fs/promises'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
const base=fileURLToPath(new URL('.',import.meta.url))
if(!process.env.LG_DSH_ROOT)throw Error('Set LG_DSH_ROOT to the LiteraryGiant dsh source directory containing the pinned node_modules.')
const modules=process.env.LG_DSH_ROOT+'/node_modules/.pnpm/'
const {build}=await import(pathToFileURL(modules+'esbuild@0.28.2/node_modules/esbuild/lib/main.js'))
const result=await build({entryPoints:[base+'adapter.jsx'],bundle:true,write:false,metafile:true,format:'iife',platform:'browser',target:'es2022',jsx:'automatic',minify:true,legalComments:'inline',define:{'process.env.NODE_ENV':'"production"'},alias:{
  'react':modules+'react@18.3.1/node_modules/react',
  'react-dom':modules+'react-dom@18.3.1_react@18.3.1/node_modules/react-dom',
  'dompurify':modules+'dompurify@3.4.16/node_modules/dompurify/dist/purify.es.mjs',
  'marked':modules+'marked@18.0.11/node_modules/marked/lib/marked.esm.js',
},plugins:[{name:'chapter-only',setup(api){api.onResolve({filter:/\/PdfViewer\.tsx$/},()=>({path:base+'pdf-unavailable.jsx'}))}}]})
const script=result.outputFiles[0].text.replace(/<\/script/gi,'<\\/script')
const license=await readFile(base+'upstream/LICENSE','utf8')
await writeFile(base+'preview.html',`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'"><title>Reading Workbench · LG 章节对照</title><style>
:root{--dsw-alias-label-primary:#292725;--dsw-alias-label-secondary:#79736c;--dsw-alias-bg-base:#fcfbf8;--dsw-alias-bg-layer-1:#f7f5f0;--dsw-alias-bg-layer-2:#efece5;--dsw-alias-bg-overlay:#fff;--dsw-alias-border-l1:#ded9cf;--dsw-alias-border-l2:#ccc5b8;--dsw-alias-brand-primary:#a66a40;--dsw-alias-state-error-primary:#b13328;--dsw-alias-state-success-primary:#287849;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}html,body,#root{height:100%;margin:0;overflow:hidden}*{box-sizing:border-box}.waiting{padding:24px}
</style></head><body><div id="root"></div><script>${script}</script><!-- ${license.replace(/--/g,'—')} --></body></html>`)
console.log('Built reading-workbench preview.html:',Buffer.byteLength(script),'JS bytes')
const localInputs=Object.keys(result.metafile.inputs).filter(path=>!path.includes('node_modules')).map(path=>path.startsWith(base)?path.slice(base.length):path)
const dependencies={react:'react@18.3.1/node_modules/react/LICENSE','react-dom':'react-dom@18.3.1_react@18.3.1/node_modules/react-dom/LICENSE',scheduler:'scheduler@0.23.2/node_modules/scheduler/LICENSE',dompurify:'dompurify@3.4.16/node_modules/dompurify/LICENSE',marked:'marked@18.0.11/node_modules/marked/LICENSE'}
await mkdir(base+'licenses',{recursive:true})
for(const [name,path] of Object.entries(dependencies))await writeFile(base+'licenses/'+name+'.txt',await readFile(modules+path))
const files=[...new Set([...localInputs,'preview.html','build.mjs','SOURCE.json','README.md','upstream/LICENSE','upstream/package.json',...Object.keys(dependencies).map(name=>'licenses/'+name+'.txt')])]
const manifest=[]
for(const path of files)manifest.push({path,sha256:createHash('sha256').update(await readFile(base+path)).digest('hex')})
await writeFile(base+'copy-manifest.json',JSON.stringify(manifest,null,2))
