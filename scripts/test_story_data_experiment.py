"""Offline budget/recovery checks. No model requests and no real credentials."""
import contextlib,copy,importlib.util,io,json,sqlite3,sys,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('story_experiment',Path(__file__).with_name('story-data-experiment.py'))
experiment=importlib.util.module_from_spec(spec);spec.loader.exec_module(experiment)

class BudgetAndRecovery(unittest.TestCase):
    def setUp(self):
        self.root=Path(tempfile.mkdtemp(prefix='lg-story-budget-'))
        self.ledger=experiment.Ledger(self.root/'budget.jsonl')
    def tearDown(self):self.ledger.lock.close()
    def test_prices_reservation_and_cap(self):
        self.ledger.reserve('flash',{'model':'deepseek-flash'})
        reserved=self.ledger.used();self.assertGreater(reserved,0)
        self.assertFalse(self.ledger.settle('flash',{}));self.assertEqual(self.ledger.used(),reserved)
        self.ledger.settle('flash',{'input_tokens':1000,'output_tokens':2000})
        self.assertAlmostEqual(self.ledger.used(),.018)
        self.ledger.reserve('pro',{'model':'deepseek-v4-pro'})
        self.ledger.settle('pro',{'input_tokens':1000,'output_tokens':2000})
        self.assertAlmostEqual(self.ledger.used(),.081)
        with self.assertRaises(RuntimeError):self.ledger.reserve('flash',{'model':'deepseek-flash'})
        with self.assertRaises(RuntimeError):self.ledger.reserve('oversized',{'model':'deepseek-flash','text':'x'*3_000_000})
    def test_response_reuse_requires_identical_request_without_network(self):
        body={'model':'deepseek-flash','messages':[]}
        experiment.dump(self.root/'cached.request.json',{'body':body})
        experiment.dump(self.root/'cached.response.json',{'stop_reason':'end_turn','content':[{'type':'text','text':'{"value":1}'}]})
        with patch.object(experiment,'credential',side_effect=AssertionError('must not read credentials')):
            self.assertEqual(experiment.call(body,self.ledger,'cached',self.root),{'value':1})
            with self.assertRaises(RuntimeError):experiment.call({'model':'deepseek-v4-pro'},self.ledger,'cached',self.root)
        self.assertEqual(self.ledger.used(),0)
    def test_artifacts_are_immutable_and_secret_errors_are_redacted(self):
        path=self.root/'artifact.json';experiment.dump(path,{'a':1});experiment.dump(path,{'a':1})
        with self.assertRaises(RuntimeError):experiment.dump(path,{'a':2})
        with patch.object(experiment,'_credential',side_effect=ValueError('synthetic-secret')):
            with self.assertRaises(RuntimeError) as caught:experiment.credential()
        self.assertNotIn('synthetic-secret',str(caught.exception))

class OfflineTransportConversion(unittest.TestCase):
    """Exercise main's host conversion with synthetic chapters and no external calls."""
    def setUp(self):
        self.root=Path(tempfile.mkdtemp(prefix='lg-story-conversion-'))
        source_root=Path(__file__).resolve().parents[1]
        self.code_root=self.root/'code'
        schema_path='dsh-plugins/lg-books/src/story-data/contract.json'
        self.schema=json.loads((source_root/schema_path).read_text())
        inputs={schema_path:json.dumps(self.schema,ensure_ascii=False),
                'dsh-plugins/lg-books/src/story-data/validate.js':'// Offline import is mocked.\n',
                'docs/story-data-contract-v1.md':'Offline conversion fixture.\n',
                'scripts/story-data-prompt.txt':'提取本章中有明确依据的事件。\n'}
        for name,text in inputs.items():
            path=self.code_root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text)
        self.book=self.root/'book';state=self.book/'.literarygiant';state.mkdir(parents=True)
        self.content='林澈关上灯，站在门口。\n两小时后，他回到了屋内。'
        (state/'project.json').write_text(json.dumps({'project_id':'offline-conversion-book'}))
        db=sqlite3.connect(state/'story.sqlite3')
        db.execute('CREATE TABLE documents (id INTEGER,title TEXT,active_version_id INTEGER,kind TEXT,state TEXT,sequence INTEGER)')
        db.execute('CREATE TABLE document_versions (id INTEGER,document_id INTEGER,content TEXT)')
        db.execute("INSERT INTO documents VALUES (7,'离线章节',11,'chapter','accepted',1)")
        db.execute('INSERT INTO document_versions VALUES (11,7,?)',(self.content,));db.commit();db.close()
        self.out=self.root/'artifacts';self.ledger=experiment.Ledger(self.out/'budget.jsonl')
        self.batches=[];self.requests=[]

    def tearDown(self):self.ledger.lock.close()

    def record(self,story_time,paragraph_transport=True):
        return dict(schema_version='1.0.0',id='ch01:event:arrival',type='event',title='林澈归来',summary='林澈回到屋内。',basis='text',
                    scope=dict(kind='chapter',description='第一章中的事件。',targets=[]),story_time=story_time,
                    evidence=[2] if paragraph_transport else [dict(paragraph=2,quote=self.content.splitlines()[1])],
                    author_note='',links=[],payload=dict(actors=[],location=None,action='林澈回到屋内。',outcome='林澈已经在屋内。',motivation='',scene=None))

    def run_conversion(self,record,transport='source-paragraphs'):
        def fake_call(body,*args):
            self.requests.append(copy.deepcopy(body));return {'records':[copy.deepcopy(record)]}
        def fake_import(argv,**kwargs):
            batch=json.loads(Path(argv[-1]).read_text());self.batches.append(batch)
            return SimpleNamespace(returncode=0,stdout=json.dumps({'count':len(batch['records'])}),stderr='')
        argv=['story-data-experiment.py','--root',str(self.code_root),'--book',str(self.book),'--artifacts',str(self.out),
              '--node','unused-offline-node','--through','1','--transport',transport,'--execute']
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(sys,'argv',argv))
            stack.enter_context(patch.object(experiment,'call',side_effect=fake_call))
            stack.enter_context(patch.object(experiment,'credential',side_effect=AssertionError('No credentials in offline conversion')))
            stack.enter_context(patch.object(experiment.urllib.request,'build_opener',side_effect=AssertionError('No network in offline conversion')))
            stack.enter_context(patch.object(experiment.subprocess,'run',side_effect=fake_import))
            stack.enter_context(patch.object(experiment,'Ledger',return_value=self.ledger))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            experiment.main()

    def test_literal_transport_uses_current_schema_version_and_source(self):
        self.assertEqual(self.schema['properties']['schema_version']['const'],'1.1.0')
        record=self.record(dict(kind='unknown',label='',after_event=None,before_event=None),False)
        self.run_conversion(record,'literal-v1')
        batch=self.batches[0];stored=batch['records'][0]['record']
        self.assertEqual(stored['schema_version'],'1.1.0')
        self.assertEqual(batch['contract_hash'],experiment.sha(experiment.canonical(self.schema)))
        self.assertEqual(stored['evidence'][0],dict(paragraph=2,quote=self.content.splitlines()[1],document_id=7,version_id=11,sha256=experiment.sha(self.content)))
        self.assertEqual(record['schema_version'],'1.0.0')
        self.assertEqual(self.ledger.used(),0)

    def test_source_paragraph_range_preserves_coordinate(self):
        coordinate=dict(axis='story-clock',unit='hour',start_min=2,start_max=3,end_min=4,end_max=5)
        self.run_conversion(self.record(dict(all_time=False,label='下午',after_event=None,before_event=None,coordinate=coordinate)))
        stored=self.batches[0]['records'][0]['record'];time=stored['story_time']
        self.assertEqual(stored['schema_version'],'1.1.0');self.assertEqual(time['kind'],'range')
        self.assertEqual(time['coordinate'],coordinate);self.assertNotIn('all_time',time)
        self.assertEqual(stored['evidence'][0]['quote'],self.content.splitlines()[1])
        transport=json.loads(next(self.out.glob('transport-*.json')).read_text())['schema']
        self.assertNotIn('schema_version',transport['properties'])
        self.assertIn('all_time',transport['properties']['story_time']['required'])
        self.assertNotIn('kind',transport['properties']['story_time']['properties'])
        self.assertEqual(transport['properties']['story_time']['properties']['coordinate'],self.schema['properties']['story_time']['properties']['coordinate'])
        self.assertTrue((self.out/'ch01.receipt.json').exists())

    def test_source_paragraph_relative_offset_without_event_bounds(self):
        offset=dict(anchor_event='ch01:event:departure',anchor_point='end',min=2,max=3,unit='hour')
        self.run_conversion(self.record(dict(all_time=False,label='离开后两至三小时',after_event=None,before_event=None,offset=offset)))
        time=self.batches[0]['records'][0]['record']['story_time']
        self.assertEqual(time['kind'],'relative');self.assertEqual(time['offset'],offset)
        self.assertNotIn('all_time',time);self.assertIsNone(time['after_event']);self.assertIsNone(time['before_event'])

    def test_all_time_coordinate_is_rejected_before_import(self):
        coordinate=dict(axis='story-clock',unit='hour',start_min=2,start_max=2,end_min=3,end_max=3)
        with self.assertRaisesRegex(RuntimeError,'Two invalid responses; chapter left unimported'):
            self.run_conversion(self.record(dict(all_time=True,label='',after_event=None,before_event=None,coordinate=coordinate)))
        self.assertEqual(len(self.requests),2);self.assertEqual(self.batches,[])
        failures=[json.loads(p.read_text()) for p in self.out.glob('*.validation.*.json')]
        self.assertEqual(len(failures),2)
        self.assertTrue(all(x['error']=='all_time cannot carry coordinate or offset' for x in failures))
        self.assertEqual(list(self.out.glob('*.batch.json')),[])
        self.assertFalse((self.out/'ch01.accepted-batch.json').exists());self.assertFalse((self.out/'ch01.receipt.json').exists())
        self.assertEqual(self.ledger.used(),0)

if __name__=='__main__':unittest.main()
