import {build, transform} from 'esbuild'
import {readFile,writeFile} from 'node:fs/promises'
const result = await build({entryPoints:['adapter.tsx'], bundle:true, write:false, format:'iife', jsx:'automatic', minify:true,
  define:{'process.env.NODE_ENV':'"production"'}, legalComments:'inline', metafile:true})
const css = (await readFile('upstream/src/client/styles.css','utf8'))+'\n'+(await readFile('upstream/src/reader/reader.css','utf8'))+`
html,body,#app{height:100%;margin:0}.lg-chapter-frame{display:flex;flex:1;min-height:0}
.lg-reading-prefs{display:flex;align-items:center;gap:4px}.lg-reading-prefs button[aria-pressed]{display:none}
.without-index .nv-reader-kicker{display:none}.nv-reader-label{font-size:13px;font-weight:500;padding-left:5px}
@media(max-width:420px){.nv-reader-bar{flex-wrap:wrap}.lg-reading-prefs{flex-wrap:wrap}}
`
const style = (await transform(css,{loader:'css',minify:true})).code
const script = result.outputFiles[0].text.replaceAll('</script','<\\/script')
await writeFile('preview.html', `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'"><title>Whalesong 阅读试用</title><style>${style}</style></head><body><div id="app"></div><script>${script}</script></body></html>`)
await writeFile('build-inputs.json',JSON.stringify(Object.keys(result.metafile.inputs),null,2))
console.log('Built Whalesong original ReaderPage -> preview.html')
