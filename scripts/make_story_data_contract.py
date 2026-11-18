from pathlib import Path
import json

root=Path(__file__).resolve().parents[1]
dest=root/'dsh-plugins/lg-books/src/story-data'
dest.mkdir(parents=True,exist_ok=True)

def text(n=600,desc='完整中文句子，说明一个明确判断；不写 Markdown 标题。',minimum=1):
 return {'type':'string','minLength':minimum,'maxLength':n,'description':desc}
def phrase(n=80): return text(n,'短语或名称，不拼接多个无关信息。')
def enum(*v): return {'enum':list(v)}
def array(item,n=20): return {'type':'array','items':item,'maxItems':n}
def obj(p,required=None): return {'type':'object','additionalProperties':False,'properties':p,'required':list(p) if required is None else required}
rid={'type':'string','pattern':'^[A-Za-z][A-Za-z0-9:_-]{0,119}$','description':'作品内稳定 ID；引用同一实体必须复用 ID。'}
ref={'$ref':'#/$defs/id'}
optional_ref={'anyOf':[ref,{'type':'null'}]}
strings=lambda n=12:array(text(240),n)
payloads={
 'entity':obj({'entity_kind':enum('character','group','place','object','concept'),'name':phrase(),'aliases':array(phrase(),20),'description':text(800)}),
 'world_rule':obj({'statement':text(),'domain':phrase(),'conditions':strings(),'exceptions':strings()}),
 'scene':obj({'pov':optional_ref,'narrator':phrase(),'location':optional_ref,'participants':array(ref),'purpose':text(),'opening':text(),'ending':text()}),
 'event':obj({'actors':array(ref),'location':optional_ref,'action':text(),'outcome':text(),'motivation':text(600,minimum=0),'scene':optional_ref}),
 'state':obj({'subject':ref,'facet':phrase(),'value':text(),'previous_record':optional_ref,'trigger_event':optional_ref}),
 'relation':obj({'subject':ref,'object':ref,'relation':phrase(),'description':text(),'trigger_event':optional_ref}),
 'knowledge':obj({'holder':ref,'proposition':text(),'stance':enum('believes','doubts','denies','uncertain'),'acquired_by':enum('experience','told','read','inference','unknown'),'trigger_event':optional_ref}),
 'revelation':obj({'proposition':text(),'presentation':enum('narration','statement','hint','correction','reveal'),'speaker':optional_ref,'about_record':optional_ref}),
 'thread':obj({'question':text(),'thread_kind':enum('conflict','mystery','foreshadowing','relationship','goal'),'progress':enum('possible','open','resolved','abandoned'),'setup_records':array(ref),'planned_payoff':text(600,minimum=0),'actual_payoff':array(ref)}),
 'plan':obj({'level':enum('book','arc','chapter','scene'),'parent':optional_ref,'objective':text(),'steps':strings(30),'expected_changes':strings(),'constraints':strings(),'reveal':strings(),'withhold':strings(),'selection':enum('option','selected','cancelled'),'realized_events':array(ref)}),
 'portrait':obj({'subject':ref,'aspect':enum('desire','value','fear','behavior','voice','contradiction','growth'),'description':text(),'counterevidence':text(600,minimum=0)}),
 'analysis':obj({'dimension':enum('summary','rhythm','emotion','style','theme','logic'),'assessment':text(1600),'limitations':strings(),'about':array(ref)}),
 'requirement':obj({'category':enum('style','viewpoint','constraint','preference'),'instruction':text(),'strength':enum('must','prefer'),'targets':array(ref)}),
}
source=obj({'document_id':{'type':'integer','minimum':1},'version_id':{'type':'integer','minimum':1},'sha256':{'type':'string','pattern':'^[a-f0-9]{64}$'},'paragraph':{'type':'integer','minimum':1},'quote':text(500,'指定段落中逐字存在的原文，不允许省略号改写。',4)})
common={
 'schema_version':{'const':'1.0.0'},
 'id':ref,'type':enum(*payloads),'title':phrase(100),'summary':text(800),
 'basis':enum('text','character_statement','inference','author'),
 'scope':obj({'kind':enum('book','chapter','scene','entity','region'),'description':text(300),'targets':array(ref)}),
 'story_time':obj({'kind':enum('all','unknown','relative','interval'),'label':text(200,minimum=0),'after_event':optional_ref,'before_event':optional_ref}),
 'evidence':array(source,16),'author_note':text(800,minimum=0),
 'links':array(obj({'relation':enum('before','causes','enables','obstructs','supports','contradicts','reveals','pays_off','part_of','motivates'),'target':ref,'explanation':text(300)}),24),
 'payload':{'type':'object'},
}
record=obj(common)
record['allOf']=[{'if':{'properties':{'type':{'const':k}},'required':['type']},'then':{'properties':{'payload':{'$ref':'#/$defs/'+k}}}} for k in payloads]
schema={'$schema':'https://json-schema.org/draft/2020-12/schema','$id':'https://literarygiant.local/contracts/story-data/1.0.0','title':'LG 书级故事记录 1.0.0',**record,'$defs':{'id':rid,'source':source,**payloads}}
# Freeze the original contract before adding new semantics. Never silently change
# its content: stored v1 hashes and immutable revision history depend on it.
legacy=dest/'contract-v1.json'
if legacy.exists():
 if json.loads(legacy.read_text())!=schema:
  raise ValueError('Frozen 1.0.0 contract differs from the original generator; no contracts written.')
else:
 with legacy.open('x') as file:
  file.write(json.dumps(schema,ensure_ascii=False,indent=2)+'\n')

schema=json.loads(json.dumps(schema))
schema['$id']='https://literarygiant.local/contracts/story-data/1.1.0'
schema['title']='LG 书级故事记录 1.1.0'
properties=schema['properties']
properties['schema_version']={'const':'1.1.0'}
properties['scope']['properties']['kind']['enum'].append('arc')
properties['links']['items']['properties']['relation']['enum']+=['simultaneous','overlaps']
time=properties['story_time']['properties']
time['kind']['enum'].append('range')
number={'type':'number','minimum':-1000000000,'maximum':1000000000}
time['coordinate']=obj({'axis':ref,'unit':enum('minute','hour','day'),
 'start_min':number,'start_max':number,'end_min':number,'end_max':number})
time['offset']=obj({'anchor_event':ref,'anchor_point':enum('start','end'),
 'min':number,'max':number,'unit':enum('minute','hour','day')})
definitions=schema['$defs']
definitions['relation']['properties']['previous_record']=optional_ref
definitions['knowledge']['properties'].update({'topic':ref,'previous_record':optional_ref})
definitions['role_assignment']=obj({'subject':ref,
 'prominence':enum('core','major','supporting','minor','unknown'),
 'roles':{'type':'array','uniqueItems':True,'maxItems':10,
          'items':enum('protagonist','antagonist','mentor','ally','other')}})
properties['type']['enum'].append('role_assignment')
schema['allOf'].append({'if':{'properties':{'type':{'const':'role_assignment'}},'required':['type']},
                       'then':{'properties':{'payload':{'$ref':'#/$defs/role_assignment'}}}})
(dest/'contract.json').write_text(json.dumps(schema,ensure_ascii=False,indent=2)+'\n')
labels=['实体档案','世界设定','场景','事件','人物与物品状态','关系变化','人物认知','读者信息揭示','情节线与伏笔','创作规划','人物侧写','分析与概括','作者要求','人物叙事身份']
catalog={k:{'label':v,'fields':list(definitions[k]['properties'])} for k,v in zip(properties['type']['enum'],labels)}
(dest/'catalog.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
print('contract version: 1.1.0; types:',len(catalog),'(frozen 1.0.0 verified)')
