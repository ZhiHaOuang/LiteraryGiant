import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {digest} from '../src/story-data/validate.js'

test('generator recreates current contracts and preserves frozen v1 byte-for-byte',()=>{
 const root=mkdtempSync(join(process.env.LG_STORY_TEST_ROOT??tmpdir(),'lg-contract-gen-'))
 const dest=join(root,'dsh-plugins/lg-books/src/story-data'),scripts=join(root,'scripts')
 mkdirSync(dest,{recursive:true});mkdirSync(scripts)
 copyFileSync(new URL('../../../scripts/make_story_data_contract.py',import.meta.url),join(scripts,'make_story_data_contract.py'))
 // URLs are resolved from lg-books/tests; repository scripts is three levels up.
 const frozen=readFileSync(new URL('../src/story-data/contract-v1.json',import.meta.url))
 writeFileSync(join(dest,'contract-v1.json'),frozen)
 const run=()=>spawnSync('python3',[join(scripts,'make_story_data_contract.py')],{encoding:'utf8',timeout:10000})
 const result=run();assert.equal(result.status,0,result.stderr)
 for(const filename of ['contract.json','catalog.json']){
  const actual=JSON.parse(readFileSync(join(dest,filename))),expected=JSON.parse(readFileSync(new URL('../src/story-data/'+filename,import.meta.url)))
  assert.deepEqual(actual,expected,filename)
  assert.equal(digest(actual),digest(expected),filename+' canonical digest')
 }
 assert.deepEqual(readFileSync(join(dest,'contract-v1.json')),frozen)
 // Refuse to bless an altered frozen contract, leaving current generated outputs alone.
 const current=readFileSync(join(dest,'contract.json'))
 const changed=JSON.parse(frozen);changed.title='Incorrect replacement';writeFileSync(join(dest,'contract-v1.json'),JSON.stringify(changed))
 const invalid=run();assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/Frozen 1.0.0/)
 assert.deepEqual(readFileSync(join(dest,'contract.json')),current)
 assert.equal(JSON.parse(readFileSync(join(dest,'contract-v1.json'))).title,'Incorrect replacement')
})
