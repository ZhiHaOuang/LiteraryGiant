import {createBook} from './fixture.mjs'
import {digest,contractHash} from '../src/story-data/validate.js'
import {importStoryData} from '../src/story-data/store.js'

export function createStoryFixture(root){
 const {db}=createBook(root)
 const texts={1:'林澈是守灯人。她收到父亲的来信。\n林澈相信父亲已死，却仍保留这封信。\n海岛的灯塔每逢涨潮便熄灭。',3:'当夜，林澈摔伤右臂。\n她把铜钥匙交给船夫阿远。',5:'三日后，林澈的伤口愈合。\n父亲在对岸的医馆醒来；林澈并不知道。'}
 for(const [id,text] of Object.entries(texts))db.prepare('UPDATE document_versions SET content=? WHERE id=?').run(text,Number(id))
 db.close()
 const source=(doc,paragraph,quote)=>({document_id:doc,version_id:doc,sha256:digest(texts[doc]),paragraph,quote})
 const e1=source(1,1,'林澈是守灯人。'),e2=source(3,1,'林澈摔伤右臂。'),e3=source(5,1,'林澈的伤口愈合。')
 const row=(id,type,title,payload,evidence=[e1],basis='text')=>({schema_version:'1.0.0',id,type,title,summary:title+'。',basis,scope:{kind:'book',description:'合成样例书',targets:[]},story_time:{kind:'unknown',label:'正文未给出精确时间',after_event:null,before_event:null},evidence,author_note:basis==='author'?'合成样例作者明确指定。':'',links:[],payload})
 const records=[
 row('person:lin','entity','林澈',{entity_kind:'character',name:'林澈',aliases:['守灯人'],description:'负责海岛灯塔的人物。'}),
 row('person:yuan','entity','阿远',{entity_kind:'character',name:'阿远',aliases:['船夫'],description:'接过铜钥匙的船夫。'},[source(3,2,'船夫阿远')]),
 row('rule:tide','world_rule','涨潮时灯塔熄灭',{statement:'灯塔每逢涨潮便熄灭。',domain:'海岛灯塔',conditions:['涨潮时。'],exceptions:[]},[source(1,3,'海岛的灯塔每逢涨潮便熄灭。')]),
 row('scene:letter','scene','守灯人收到来信',{pov:'person:lin',narrator:'第三人称叙述',location:null,participants:['person:lin'],purpose:'展示人物的失落与未解疑问。',opening:'林澈守灯。',ending:'她仍保留来信。'},[e1,source(1,2,'却仍保留这封信。')],'inference'),
 row('event:injury','event','林澈摔伤',{actors:['person:lin'],location:null,action:'林澈摔倒并伤及右臂。',outcome:'她的右臂受伤。',motivation:'',scene:null},[e2]),
 row('event:healing','event','伤口愈合',{actors:['person:lin'],location:null,action:'伤口在三日后愈合。',outcome:'伤口已经愈合。',motivation:'',scene:null},[e3]),
 row('state:injured','state','右臂受伤期间',{subject:'person:lin',facet:'身体状态',value:'右臂受伤。',previous_record:null,trigger_event:'event:injury'},[e2]),
 row('relation:key','relation','林澈将钥匙交给阿远',{subject:'person:lin',object:'person:yuan',relation:'物品交接',description:'林澈将铜钥匙交给阿远；不能据此直接确认两人互相信任。',trigger_event:null},[source(3,2,'她把铜钥匙交给船夫阿远。')]),
 row('knowledge:death','knowledge','林澈相信父亲已死',{holder:'person:lin',proposition:'父亲已经死亡。',stance:'believes',acquired_by:'unknown',trigger_event:null},[source(1,2,'林澈相信父亲已死')]),
 row('revelation:alive','revelation','读者得知父亲醒来',{proposition:'父亲在医馆醒来，林澈尚不知道。',presentation:'reveal',speaker:null,about_record:'knowledge:death'},[source(5,2,'父亲在对岸的医馆醒来；林澈并不知道。')]),
 row('thread:father','thread','父亲真实处境',{question:'林澈何时得知父亲的处境？',thread_kind:'mystery',progress:'open',setup_records:['knowledge:death','revelation:alive'],planned_payoff:'',actual_payoff:[]},[source(5,2,'林澈并不知道。')],'inference'),
 row('plan:crossing','plan','下一章前往对岸',{level:'chapter',parent:null,objective:'让林澈主动追查来信。',steps:['决定渡海。','寻找船夫。'],expected_changes:['从等待转为行动。'],constraints:['暂不相认。'],reveal:[],withhold:['父亲的具体位置。'],selection:'option',realized_events:[]},[],'author'),
 row('portrait:letter','portrait','保留旧信的倾向',{subject:'person:lin',aspect:'contradiction',description:'相信亲人已死，却仍保留来信，可能存在未放下的牵挂。',counterevidence:'仅一处表现，不能据此确定她在所有关系中的行为。'},[source(1,2,'林澈相信父亲已死，却仍保留这封信。')],'inference'),
 row('analysis:rhythm','analysis','短句形成信息落差',{dimension:'rhythm',assessment:'父亲醒来与林澈不知并置，使读者暂时比人物掌握更多信息。',limitations:['只分析本段，不能代表全书节奏。'],about:['revelation:alive']},[source(5,2,'父亲在对岸的医馆醒来；林澈并不知道。')],'inference'),
 row('requirement:voice','requirement','保持克制叙述',{category:'style',instruction:'使用克制的第三人称叙述。',strength:'prefer',targets:[]},[],'author'),
 ]
 records.find(r=>r.id==='event:injury').links=[{relation:'before',target:'event:healing',explanation:'愈合发生在摔伤三日后。'}]
 records.find(r=>r.id==='state:injured').story_time={kind:'interval',label:'摔伤后至愈合前',after_event:'event:injury',before_event:'event:healing'}
 const batch={schema:'lg.story-data.batch.v1',contract_hash:contractHash,book_id:'test-book',branch:'main',operation:'fixture:all-types',run:{id:'fixture:all-types',producer:'author',method:'人工编写的合成示例，非模型质量证据'},coverage:Object.entries(texts).map(([id,content])=>({document_id:Number(id),version_id:Number(id),sha256:digest(content),status:'complete',note:'合成正文样例'})),records:records.map(record=>({expected_revision:null,record}))}
 importStoryData(root,batch)
 return batch
}
