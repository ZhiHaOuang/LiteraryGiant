"""Audited single-book cleaning against a local OpenAI-compatible model server."""
from __future__ import annotations
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import time
from urllib.parse import urlparse
import requests
from Jormungandr.hardmodel.chapter_cleaner import RawNovelBook
from Jormungandr.hardmodel.llm_noise_classifier import VLLMWeakNoiseClassifier


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


def validate_response(response, batch):
    choice = response['choices'][0]
    if choice.get('finish_reason') != 'stop':
        raise ValueError('Model output did not finish normally')
    value = json.loads(choice['message']['content'])
    if not isinstance(value, dict) or set(value) != {'d', 't'}:
        raise ValueError('Expected exactly d and t arrays')
    if not isinstance(value['d'], list) or not isinstance(value['t'], list):
        raise ValueError('Expected arrays')
    rows = {row['candidate_id']: row for row in batch}
    seen, actions = set(), []
    for action, items in [('drop', value['d']), ('trim', value['t'])]:
        for item in items:
            if action == 'trim':
                if not isinstance(item, list) or len(item) != 2:
                    raise ValueError('Invalid trim')
                identity, text = item
            else:
                identity, text = item, None
            if type(identity) is not int or identity not in rows or identity in seen:
                raise ValueError('Unknown or duplicate candidate ID')
            seen.add(identity)
            result = {'candidate_id': identity, 'action': action}
            if action == 'trim':
                if not isinstance(text, str) or not text.strip() or text not in rows[identity]['line']:
                    raise ValueError('Trim must preserve a nonempty original substring')
                result['cleaned_line'] = text
            actions.append(result)
    return actions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--model-dir', required=True, type=Path)
    parser.add_argument('--base-url', default='http://127.0.0.1:18080/v1')
    parser.add_argument('--model', default='lg-clean-qwen14b')
    parser.add_argument('--prefix', type=int, default=100)
    parser.add_argument('--batch-size', type=int, default=8)
    parser.add_argument('--replay-from', type=Path, help='Reuse exact recorded requests without model calls')
    args = parser.parse_args()
    if urlparse(args.base_url).hostname not in {'localhost', '127.0.0.1', '::1'}:
        parser.error('Only a local model endpoint is allowed')
    if args.prefix < 1 or args.batch_size < 1:
        parser.error('prefix and batch-size must be positive')
    args.output.mkdir(parents=True, exist_ok=True)
    raw = args.source.read_bytes()
    source_hash = digest(raw)
    # Fingerprint exact model files once per invocation, before any cached inference reuse.
    model_hashes = {}
    for path in sorted(args.model_dir.iterdir()):
        if path.suffix in {'.json', '.safetensors', '.txt'}:
            h = hashlib.sha256()
            with path.open('rb') as f:
                for chunk in iter(lambda: f.read(8 * 1024 * 1024), b''): h.update(chunk)
            model_hashes[path.name] = h.hexdigest()
    rules = Path(__import__('Jormungandr.hardmodel.chapter_cleaner', fromlist=['x']).__file__).parent
    rule_hashes = {p.name: digest(p.read_bytes()) for p in sorted(rules.glob('*.py'))}
    identity = {'source_sha256': source_hash, 'model_files': model_hashes, 'rules': rule_hashes,
                'runner_sha256': digest(Path(__file__).read_bytes()), 'prefix': args.prefix,
                'batch_size': args.batch_size, 'model': args.model}
    identity_path = args.output / 'identity.json'
    if identity_path.exists() and json.loads(identity_path.read_text()) != identity:
        raise ValueError('Existing run has different input, model or implementation; use a new output directory')
    save(identity_path, identity)
    if args.replay_from:
        prior = json.loads((args.replay_from/'identity.json').read_text())
        for key in ['source_sha256', 'model_files', 'batch_size', 'model']:
            if prior[key] != identity[key]: raise ValueError('Replay provenance differs: ' + key)
    book = RawNovelBook(args.source, book_id='id000001')
    book.raw_text = book.read_text()
    book.normalized_text = book._ensure_paragraphs(book.normalize_text(book.raw_text))
    draft = book.prepare_clean_text(book.normalized_text)
    before_model = book.render_clean_text(draft)
    client = VLLMWeakNoiseClassifier(batch_size=args.batch_size, max_batch_characters=12000)
    batches = client._build_batches(draft.uncertain_windows)
    session = requests.Session(); session.trust_env = False
    all_actions = []
    start = time.monotonic()
    for index, batch in enumerate(batches):
        request = {'model': args.model, 'messages': [
            {'role': 'system', 'content': '你是保守的中文网文清洗器，只判断候选行是否为正文外噪声。小说正文、对白、人物心理、世界观设定和系统提示一律保留。默认keep并省略所有keep项。只输出JSON对象，格式严格为{"d":[整行删除的id],"t":[[id,"应保留的原文连续子串"]]}。不得改写正文。'},
            {'role': 'user', 'content': client._build_prompt(batch)}],
            'temperature': 0, 'max_tokens': 1024,
            'response_format': {'type': 'json_object'}}
        receipt = args.output / f'batch-{index:04d}.json'
        if args.replay_from and not receipt.exists():
            result = json.loads((args.replay_from/receipt.name).read_text())
            if result['request'] != request: raise ValueError('Replay request differs')
            save(receipt, {**result, 'replayed_from': str(args.replay_from/receipt.name)})
        if receipt.exists():
            result = json.loads(receipt.read_text())
            if result['request'] != request: raise ValueError('Checkpoint request changed')
        else:
            t = time.monotonic()
            response = session.post(args.base_url.rstrip('/') + '/chat/completions', json=request, timeout=600)
            response.raise_for_status()
            result = {'request': request, 'response': response.json(), 'seconds': time.monotonic()-t}
            save(receipt, result)
        all_actions.extend(validate_response(result['response'], batch))
        save(args.output/'progress.json', {'status': 'running', 'completed_batches': index+1,
              'total_batches': len(batches), 'elapsed_seconds': time.monotonic()-start})
        print(f'batch {index+1}/{len(batches)} validated', flush=True)
    book.apply_weak_noise_results(draft, all_actions)
    book.cleaning_stats['weak_classifier_calls'] = len(batches)
    book.cleaning_stats['weak_classifier_windows'] = len(draft.uncertain_windows)
    book.cleaned_text = book.render_clean_text(draft)
    chapters = [c.to_dict() for c in book.split_chapters(book.cleaned_text)]
    numbered = [c for c in chapters if c['chapter_no'] is not None]
    prefix = numbered[:args.prefix]
    if [c['chapter_no'] for c in prefix] != list(range(1, args.prefix+1)):
        raise ValueError('Prefix chapter numbers are not continuous')
    if digest(args.source.read_bytes()) != source_hash:
        raise ValueError('Source changed while processing')
    save(args.output/'chapters.json', chapters)
    save(args.output/'prefix.json', {'source_sha256': source_hash, 'status': 'cleaned-draft', 'chapters': prefix})
    (args.output/'cleaned.txt').write_text(book.cleaned_text, encoding='utf-8')
    (args.output/'normalization.diff').write_text(''.join(difflib.unified_diff(book.raw_text.splitlines(True), book.normalized_text.splitlines(True), fromfile='decoded-source', tofile='normalized')), encoding='utf-8')
    (args.output/'rules.diff').write_text(''.join(difflib.unified_diff(book.normalized_text.splitlines(True), before_model.splitlines(True), fromfile='normalized', tofile='rule-cleaned')), encoding='utf-8')
    (args.output/'model.diff').write_text(''.join(difflib.unified_diff(before_model.splitlines(True), book.cleaned_text.splitlines(True), fromfile='rule-cleaned', tofile='model-cleaned')), encoding='utf-8')
    summary = {'status': 'complete', 'source_sha256': source_hash, 'source_unchanged': True,
        'text_units': len(chapters), 'numbered_chapters': len(numbered), 'prefix_chapters': len(prefix),
        'windows': len(draft.uncertain_windows), 'batches': len(batches),
        'stats': book.cleaning_stats, 'model_actions': all_actions,
        'elapsed_seconds': time.monotonic()-start}
    save(args.output/'summary.json', summary)
    save(args.output/'progress.json', summary)
    print(json.dumps({k:v for k,v in summary.items() if k not in {'model_actions','stats'}}), flush=True)


if __name__ == '__main__': main()
