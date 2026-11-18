#!/usr/bin/env python3
"""Bounded, resumable offline-first extraction experiment. No production tool/agent API.

Credentials stay in memory. Durable reservation precedes every model request.
Uncertain network outcomes retain their reservation and require manual review.
"""
import argparse, copy, datetime, fcntl, hashlib, json, os, re, sqlite3, subprocess, sys
import urllib.error, urllib.request, ssl
import certifi
from pathlib import Path

ENDPOINT='https://api.deepseek.com/anthropic/v1/messages'
MODEL='deepseek-flash'
MAX_OUTPUT=18000
LIMIT=10.0
PRICES={'deepseek-flash':(2,8),'deepseek-v4-pro':(9,27)}

def dump(path, data):
    path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists():
        if json.loads(path.read_text())==data:return
        raise RuntimeError('Refusing to replace experiment artifact: '+path.name)
    with path.open('x',encoding='utf8') as f:
        json.dump(data,f,ensure_ascii=False,indent=2); f.flush(); os.fsync(f.fileno())
def sha(data): return hashlib.sha256(data.encode() if isinstance(data,str) else data).hexdigest()
def canonical(data): return json.dumps(data,ensure_ascii=False,sort_keys=True,separators=(',',':'))
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()

class Ledger:
    def __init__(self,path):
        self.path=path;path.parent.mkdir(parents=True,exist_ok=True)
        self.lock=path.with_suffix('.lock').open('a');fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        self.rows=[json.loads(l) for l in path.read_text().splitlines()] if path.exists() else []
    def append(self,row):
        row['at']=now()
        with self.path.open('a') as f: f.write(json.dumps(row)+'\n');f.flush();os.fsync(f.fileno())
        self.rows.append(row)
    def used(self):
        amounts={}
        for r in self.rows:
            amounts[r['id']]=r['reserved_cny'] if r['kind']=='reserve' else r['upper_charge_cny']
        return sum(amounts.values())
    def reserve(self,id,body):
        if any(r['id']==id for r in self.rows):raise RuntimeError('Attempt already recorded; refusing automatic resend: '+id)
        # UTF-8 byte count upper-bounds normal token counts; add protocol overhead.
        # Twice the published peak uncached price is reserved, usage is later settled at peak.
        input_bound=len(canonical(body).encode())+4096
        rates=PRICES[body['model']]
        amount=(input_bound*rates[0]*2+MAX_OUTPUT*rates[1]*2)/1_000_000
        if self.used()+amount>LIMIT:raise RuntimeError('10 CNY budget cannot cover next worst-case reservation')
        self.append(dict(kind='reserve',id=id,reserved_cny=amount,model=body['model'],input_token_bound=input_bound,max_output_tokens=MAX_OUTPUT))
    def settle(self,id,usage):
        # Cache creation/read are additive in the Anthropic protocol. Charge all at cache-miss peak.
        fields=['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens']
        if not isinstance(usage,dict) or any(not isinstance(usage.get(k,0),int) or usage.get(k,0)<0 for k in fields) or 'output_tokens' not in usage or 'input_tokens' not in usage:
            return False
        inputs=sum(usage.get(k,0) for k in fields[:-1]);out=usage['output_tokens']
        reservation=next(r for r in self.rows if r['kind']=='reserve' and r['id']==id)
        rates=PRICES[reservation.get('model','deepseek-flash')]
        self.append(dict(kind='settle',id=id,usage=usage,upper_charge_cny=(inputs*rates[0]+out*rates[1])/1_000_000))
        if self.used()>LIMIT:raise RuntimeError('Provider usage exceeded expected bound; stopped')
        return True

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise RuntimeError('Credential redirect refused')

def _credential():
    key=os.environ.get('DEEPSEEK_API_KEY','').strip()
    if key:return 'x-api-key',key,'api-key'
    import yaml
    p=Path.home()/'.dsh/.credentials.yaml'
    r=yaml.safe_load(p.read_text())['records']['deepseek-account-platform/default']
    v=r.get('payload',{})
    if r.get('kind')!='grant' or v.get('version')!=1 or v.get('issuer','').rstrip('/')!='https://platform.deepseek.com' or not isinstance(v.get('token'),str) or not v['token'] or v['token'].startswith('dsh_mock_'):
        raise RuntimeError('DSH production credential origin validation failed')
    return 'x-dsh-auth-token',v['token'],'dsh-account'

def credential():
    try:return _credential()
    except Exception:raise RuntimeError('Validated DeepSeek credentials unavailable; credential content was not logged') from None

def call(body,ledger,attempt,outdir):
    cached=outdir/(attempt+'.response.json')
    if cached.exists():
        original=json.loads((outdir/(attempt+'.request.json')).read_text())
        if original['body']!=body:raise RuntimeError('Cached request differs; cannot relabel previous response')
        response=json.loads(cached.read_text())
        if response.get('stop_reason')=='max_tokens':raise RuntimeError('Cached response was truncated')
        print(json.dumps({'reused_response':attempt}),flush=True)
        text=''.join(c['text'] for c in response.get('content',[]) if c.get('type')=='text')
        return json.loads(re.sub(r'^```(?:json)?\s*|\s*```$','',text.strip()))
    header,token,kind=credential()
    dump(outdir/(attempt+'.request.json'),dict(endpoint=ENDPOINT,auth_kind=kind,body=body))
    ledger.reserve(attempt,body)
    req=urllib.request.Request(ENDPOINT,json.dumps(body,ensure_ascii=False).encode(),headers={header:token,'content-type':'application/json','anthropic-version':'2023-06-01','accept':'application/json'},method='POST')
    try:
        with urllib.request.build_opener(NoRedirect(),urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=certifi.where()))).open(req,timeout=240) as r:
            raw=r.read(8_000_000)
    except Exception as error:
        # Never log exception request headers/body; unknown charge retains full reservation.
        dump(outdir/(attempt+'.failure.json'),dict(kind=type(error).__name__,status=getattr(error,'code',None),reservation_retained=True))
        raise RuntimeError('Request failed; reservation retained, no automatic retry: '+attempt) from None
    response=json.loads(raw)
    # Only response content/usage, never headers or auth-bearing request objects.
    dump(outdir/(attempt+'.response.json'),response)
    settled=ledger.settle(attempt,response.get('usage'))
    if not settled:raise RuntimeError('Usage unavailable; reservation retained; stop for inspection')
    if response.get('stop_reason')=='max_tokens':raise RuntimeError('Truncated output; stop without automatic continuation')
    text=''.join(c['text'] for c in response.get('content',[]) if c.get('type')=='text')
    return json.loads(re.sub(r'^```(?:json)?\s*|\s*```$','',text.strip()))

def main():
    global MODEL
    ap=argparse.ArgumentParser();ap.add_argument('--root',required=True);ap.add_argument('--book',required=True);ap.add_argument('--artifacts',required=True);ap.add_argument('--node',required=True);ap.add_argument('--execute',action='store_true');ap.add_argument('--through',type=int,default=20);ap.add_argument('--attempt-prefix',default='main');ap.add_argument('--prompt-file',default='scripts/story-data-prompt.txt');ap.add_argument('--transport',choices=['literal-v1','source-paragraphs'],default='literal-v1');ap.add_argument('--model',choices=list(PRICES),default='deepseek-flash')
    a=ap.parse_args();MODEL=a.model;root=Path(a.root);book=Path(a.book);out=Path(a.artifacts);out.mkdir(parents=True,exist_ok=True)
    if not 1<=a.through<=20:raise RuntimeError('Only the first 20 chapters are authorized')
    files=['dsh-plugins/lg-books/src/story-data/contract.json','dsh-plugins/lg-books/src/story-data/validate.js','docs/story-data-contract-v1.md','scripts/story-data-prompt.txt']
    freeze={f:sha((root/f).read_bytes()) for f in files}
    frozen=out/'contract-freeze.json'
    if frozen.exists():
        if json.loads(frozen.read_text())['files']!=freeze:raise RuntimeError('Frozen contract changed')
    else:dump(frozen,dict(at=now(),files=freeze,model=MODEL,thinking='disabled',budget_cny=LIMIT,pricing='https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',input_peak_cny_per_million=2,output_peak_cny_per_million=8))
    schema=json.loads((root/files[0]).read_text());contract_hash=sha(canonical(schema))
    prompt_text=(root/a.prompt_file).read_text();prompt_hash=sha(prompt_text)
    prompt_freeze=out/('prompt-'+prompt_hash+'.json')
    if not prompt_freeze.exists():dump(prompt_freeze,dict(at=now(),file=a.prompt_file,sha256=prompt_hash))
    model_schema=copy.deepcopy(schema)
    if a.transport=='source-paragraphs':
        model_schema['properties'].pop('schema_version');model_schema['required'].remove('schema_version')
        model_schema['properties']['evidence']={'type':'array','minItems':1,'maxItems':16,'uniqueItems':True,'items':{'type':'integer','minimum':1}}
        st=model_schema['properties']['story_time'];st['properties'].pop('kind');st['properties']['all_time']={'type':'boolean'};st['required'].remove('kind');st['required'].append('all_time')
        model_schema['properties']['type']['enum']=[t for t in model_schema['properties']['type']['enum'] if t not in ['plan','requirement']]
        model_schema['allOf']=[c for c in model_schema['allOf'] if c['if']['properties']['type']['const'] not in ['plan','requirement']]
    transport_file=out/('transport-'+sha(canonical(model_schema))+'.json')
    if not transport_file.exists():dump(transport_file,dict(at=now(),transport=a.transport,schema=model_schema))
    prompt=prompt_text+'\n本轮模型输出 JSON Schema（宿主将转换为冻结的存储契约）：\n'+canonical(model_schema)
    db=sqlite3.connect('file:'+str(book/'.literarygiant/story.sqlite3')+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
    rows=[dict(r) for r in db.execute("SELECT d.id,d.title,d.active_version_id,v.content FROM documents d JOIN document_versions v ON v.id=d.active_version_id AND v.document_id=d.id WHERE d.kind='chapter' AND d.state NOT IN ('archived','rejected') ORDER BY d.sequence,d.id LIMIT ?",(a.through,))]
    project=json.loads((book/'.literarygiant/project.json').read_text())
    if len(rows)!=a.through:raise RuntimeError('Insufficient source chapters')
    model_file=out/('model-'+MODEL+'.json')
    if not model_file.exists():dump(model_file,dict(at=now(),model=MODEL,thinking='disabled',peak_prices=PRICES[MODEL],budget_cny=LIMIT))
    ledger=Ledger(out/'budget.jsonl');entities=[]
    for index,row in enumerate(rows,1):
        prefix=f'ch{index:02d}';source=dict(document_id=row['id'],version_id=row['active_version_id'],sha256=sha(row['content']))
        complete=out/(prefix+'.receipt.json')
        if complete.exists():
            receipt=json.loads(complete.read_text())
            if not isinstance(receipt.get('count'),int) or receipt['count']<1:raise RuntimeError('Invalid completion receipt')
            batch=json.loads((out/(prefix+'.accepted-batch.json')).read_text())
            if batch['coverage'][0]['sha256']!=source['sha256']:raise RuntimeError('Completed chapter changed')
            entities.extend(dict(id=x['record']['id'],**x['record']['payload']) for x in batch['records'] if x['record']['type']=='entity');continue
        paras=[s.strip() for s in row['content'].splitlines() if s.strip()]
        content=canonical(dict(chapter=index,title=row['title'],id_prefix=prefix,entity_directory=entities,paragraphs=[dict(paragraph=i+1,text=p) for i,p in enumerate(paras)]))
        body=dict(model=MODEL,max_tokens=MAX_OUTPUT,thinking={'type':'disabled'},stream=False,system=prompt,messages=[dict(role='user',content=content)])
        if not a.execute:
            print(json.dumps(dict(chapter=index,chars=len(row['content']),source=source,request_bytes=len(canonical(body).encode())),ensure_ascii=False));continue
        error=None
        for attempt_num in range(2):
            attempt=f'{a.attempt_prefix}-{prefix}-a{attempt_num+1}'
            if error:body['messages']=[dict(role='user',content=content+'\n上一输出未通过校验。请完整重新输出，修复：'+error+'\n上一输出：'+canonical(result))]
            print(json.dumps(dict(start=attempt,budget_used_upper=round(ledger.used(),6))),flush=True)
            result=call(body,ledger,attempt,out)
            records=[]
            try:
                if not isinstance(result.get('records'),list) or not 1<=len(result['records'])<=100 or ('coverage_note' in result and not isinstance(result['coverage_note'],str)):raise ValueError('Expected records (1..100) and optional string coverage_note')
                for r in copy.deepcopy(result['records']):
                    r['schema_version']=schema['properties']['schema_version']['const']
                    if a.transport=='source-paragraphs':
                        if not all(type(n) is int and 1<=n<=len(paras) and 4<=len(paras[n-1])<=500 for n in r['evidence']):raise ValueError('Evidence paragraph out of bounds or outside 4..500 characters')
                        r['evidence']=[dict(paragraph=n,quote=paras[n-1]) for n in r['evidence']]
                        st=r['story_time'];all_time=st.pop('all_time')
                        if type(all_time) is not bool:raise ValueError('all_time must be boolean')
                        if all_time and (st.get('coordinate') or st.get('offset')):raise ValueError('all_time cannot carry coordinate or offset')
                        st['kind']='all' if all_time else 'range' if st.get('coordinate') else 'interval' if st.get('after_event') and st.get('before_event') else 'relative' if st.get('after_event') or st.get('before_event') or st.get('offset') else 'unknown'
                    for e in r['evidence']:
                        if set(e)-{'paragraph','quote','document_id','version_id','sha256'}:raise ValueError('Unexpected evidence fields')
                        e.update(source)
                    records.append(dict(expected_revision=None,record=r))
                batch=dict(schema='lg.story-data.batch.v1',contract_hash=contract_hash,book_id=project['project_id'],branch='main',operation=attempt,run=dict(id=attempt,producer='model',method='chapter extraction '+a.prompt_file,prompt_sha256=prompt_hash,transport=a.transport,transport_schema_sha256=sha(canonical(model_schema)),model=MODEL,contract_freeze=sha(canonical(freeze)),request=attempt,scope='current chapter plus earlier entity directory'),coverage=[dict(**source,status='partial',note=result.get('coverage_note','模型未提供覆盖说明；按部分提取登记。'))],records=records)
                batchfile=out/(attempt+'.batch.json');dump(batchfile,batch)
                proc=subprocess.run([a.node,str(root/'scripts/story-data-import.mjs'),str(root),str(book),str(batchfile)],capture_output=True,text=True,env={**os.environ,'NODE_NO_WARNINGS':'1'})
                if proc.returncode:raise ValueError(proc.stderr.strip())
                dump(out/(prefix+'.accepted-batch.json'),batch);dump(complete,json.loads(proc.stdout))
                entities.extend(dict(id=x['record']['id'],**x['record']['payload']) for x in records if x['record']['type']=='entity')
                print(json.dumps(dict(done=prefix,records=len(records),budget_used_upper=round(ledger.used(),6))),flush=True);break
            except (ValueError,KeyError,TypeError) as e:
                error=str(e)[:3000];dump(out/(attempt+'.validation.'+sha(error)[:8]+'.json'),dict(error=error))
                print(json.dumps(dict(validation_failure=attempt,error=error)),flush=True)
        else:raise RuntimeError('Two invalid responses; chapter left unimported: '+prefix)
    print(json.dumps(dict(completed_through=a.through,executed=a.execute,budget_used_upper=round(ledger.used(),6))),flush=True)

if __name__=='__main__':
    try:main()
    except Exception as e:
        print(type(e).__name__+': '+str(e),file=sys.stderr);sys.exit(1)
