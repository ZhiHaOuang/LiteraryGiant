import {resolve} from 'node:path'
import {exportStorySnapshot,readStorySnapshot} from '../lg-books/src/story-data/snapshot.js'
const args=process.argv.slice(2),options={}
for(let i=0;i<args.length;i+=2){if(!['--book','--output','--read','--expected-revision'].includes(args[i])||!args[i+1]||options[args[i]])throw Error('用法：--book /book [--output /directory] [--expected-revision HASH]；或 --read /snapshot-directory');options[args[i]]=args[i+1]}
if(options['--read']){if(Object.keys(options).length!==1)throw Error('--read 不能混用写入参数');const result=readStorySnapshot(resolve(options['--read']));console.log(JSON.stringify({manifest:result.manifest,records:result.records.length}))}
else {if(!options['--book'])throw Error('需要 --book');console.log(JSON.stringify(exportStorySnapshot(resolve(options['--book']),{...(options['--output']&&{output:resolve(options['--output'])}),expected_revision:options['--expected-revision']}),null,2))}
