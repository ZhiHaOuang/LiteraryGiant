import {DatabaseSync} from 'node:sqlite'
import {mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {measureShelf} from './space-meter.js'

function openHistory(profile) {
  let file=':memory:'
  if(profile){
    const directory=join(profile,'lg-storydata')
    mkdirSync(directory,{recursive:true,mode:0o700})
    file=join(directory,'storage-history.sqlite3')
  }
  const db=new DatabaseSync(file)
  try {
    db.exec(`PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY, shelf TEXT NOT NULL, unit TEXT NOT NULL,
        mark TEXT NOT NULL, position INTEGER NOT NULL, parts TEXT NOT NULL, previous TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS samples_series ON samples(shelf,unit,id)`)
    return db
  } catch(error){db.close();throw error}
}

function record(db,scope,unit,progress,parts) {
  if(!progress)return []
  const {mark,position}=progress
  const last=db.prepare('SELECT id,mark,parts FROM samples WHERE shelf=? AND unit=? ORDER BY id DESC LIMIT 1').get(scope,unit)
  const current=JSON.stringify(parts)
  if(last?.mark===mark){
    if(last.parts!==current)db.prepare('UPDATE samples SET parts=? WHERE id=?').run(current,last.id)
  } else {
    db.prepare('INSERT INTO samples(shelf,unit,mark,position,parts,previous) VALUES(?,?,?,?,?,?)')
      .run(scope,unit,mark,position,current,last?.parts??current)
  }
  // The first measurement of a shelf is a baseline. Keep its original bytes
  // even when later refreshes update the same narrative position.
  return db.prepare('SELECT position,parts,previous FROM samples WHERE shelf=? AND unit=? ORDER BY id DESC LIMIT 120')
    .all(scope,unit).reverse().map(row=>({position:row.position,parts:JSON.parse(row.parts),previous:JSON.parse(row.previous)}))
}

export function createSpaceReader(books,{profile,segments=()=>null}={}) {
  let pending
  async function read(){
    const {shelfKey,chapter,plot,...current}=await measureShelf(books,segments())
    const history={chapter:[],plot:[]}
    let historyStatus=current.unavailable.length?'incomplete':profile?'saved':'session'
    if(current.bookCount&&!current.unavailable.length){
      let db
      try{
        db=profile?openHistory(profile):(memory??=openHistory())
        db.exec('BEGIN IMMEDIATE')
        try{
          history.chapter=record(db,shelfKey,'chapter',chapter,current.parts)
          history.plot=record(db,shelfKey,'plot',plot,current.parts)
          db.exec('COMMIT')
        }catch(error){db.exec('ROLLBACK');throw error}
      }catch{historyStatus='unavailable';history.chapter=[];history.plot=[]}
      finally{if(profile)db?.close()}
    }
    return {version:'lg.storydata.space.v1',...current,chapters:chapter?.position??0,history,historyStatus,plotAvailable:plot!==null}
  }
  let memory
  return {read(){return pending??=read().finally(()=>{pending=undefined})},close(){memory?.close();memory=undefined}}
}
