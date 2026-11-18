#!/usr/bin/env python3
"""Publish validated candidates, retaining sources and proving legacy tables unchanged."""
import argparse,hashlib,json,os,shutil,sqlite3,subprocess
from pathlib import Path

def fingerprint(db):
    result={}
    names=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'lg_story_data_%' ORDER BY name")]
    for name in names:
        safe='"'+name.replace('"','""')+'"'
        hashes=[hashlib.sha256(json.dumps(list(row),ensure_ascii=False,separators=(',',':'),default=lambda v:v.hex()).encode()).hexdigest() for row in db.execute('SELECT * FROM '+safe)]
        result[name]={'rows':len(hashes),'sha256':hashlib.sha256(''.join(sorted(hashes)).encode()).hexdigest()}
    return result

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--book',required=True);p.add_argument('--artifacts',required=True);p.add_argument('--node',required=True);p.add_argument('--through',type=int,default=20)
    a=p.parse_args();root=Path(a.root);book=Path(a.book).resolve();source=Path(a.artifacts).resolve()
    if not 1<=a.through<=20:raise RuntimeError('Publication limited to first 20 chapters')
    target=book/'.literarygiant/experiments/story-data-20261111';target.mkdir(parents=True,exist_ok=True)
    database=book/'.literarygiant/story.sqlite3'
    with sqlite3.connect('file:'+str(database)+'?mode=ro',uri=True) as db:
        before=fingerprint(db)
        if not (target/'database-before.sqlite3').exists():
            with sqlite3.connect(target/'database-before.sqlite3') as backup:db.backup(backup)
            shutil.copy2(book/'.literarygiant/project.json',target/'project-before.json')
    batches=[]
    for n in range(1,a.through+1):
        prefix=f'ch{n:02d}';receipt=json.loads((source/(prefix+'.receipt.json')).read_text());batch=json.loads((source/(prefix+'.accepted-batch.json')).read_text())
        if receipt.get('count')!=len(batch['records']) or receipt.get('operation')!=batch['operation']:raise RuntimeError('Receipt mismatch: '+prefix)
        batch['run']['artifact_directory']='.literarygiant/experiments/story-data-20261111'
        destination=target/(prefix+'.published-batch.json');text=json.dumps(batch,ensure_ascii=False,indent=2)
        if destination.exists() and destination.read_text()!=text:raise RuntimeError('Published batch already has different content')
        destination.write_text(text);batches.append((prefix,destination))
    # Copy only explicit experiment JSON/text, not credentials or lock/process files.
    for file in source.iterdir():
        if not file.is_file() or file.suffix not in ('.json','.jsonl','.txt'):continue
        dst=target/file.name
        if dst.exists() and dst.read_bytes()!=file.read_bytes():
            if file.name!='budget.jsonl':raise RuntimeError('Archived artifact changed: '+file.name)
            if not file.read_bytes().startswith(dst.read_bytes()):raise RuntimeError('Budget ledger was rewritten')
        shutil.copy2(file,dst)
    receipts=[]
    for prefix,batch in batches:
        process=subprocess.run([a.node,str(root/'scripts/story-data-import.mjs'),str(root),str(book),str(batch)],capture_output=True,text=True,env={**os.environ,'NODE_NO_WARNINGS':'1'})
        if process.returncode:raise RuntimeError('Import failed '+prefix+': '+process.stderr.strip())
        receipt=json.loads(process.stdout);(target/(prefix+'.published-receipt.json')).write_text(json.dumps(receipt,indent=2));receipts.append(receipt)
    with sqlite3.connect('file:'+str(database)+'?mode=ro',uri=True) as db:
        after=fingerprint(db);assert before==after,'Legacy tables changed during publication; inspect concurrent edits, do not overwrite them'
        approvals=dict(db.execute('SELECT v.approval,count(*) FROM lg_story_data_records r JOIN lg_story_data_revisions v ON v.id=r.head GROUP BY v.approval'))
        integrity=db.execute('PRAGMA integrity_check').fetchone()[0]
    result={'through_chapter':a.through,'batches':len(receipts),'imported_records':sum(r['count'] for r in receipts),'legacy_tables_unchanged':True,'legacy_table_fingerprints':after,'approvals':approvals,'integrity':integrity}
    (target/f'publication-through-{a.through:02d}.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps({k:v for k,v in result.items() if k!='legacy_table_fingerprints'},ensure_ascii=False))

if __name__=='__main__':main()
