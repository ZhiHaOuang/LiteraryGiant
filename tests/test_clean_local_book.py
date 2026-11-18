import json
import unittest
from scripts.clean_local_book import validate_response

class ResponseChecks(unittest.TestCase):
    batch = [{'candidate_id': 7, 'line': '正文广告'}]
    def response(self, value, reason='stop'):
        return {'choices': [{'finish_reason': reason, 'message': {'content': json.dumps(value)}}]}
    def test_keep_and_trim(self):
        self.assertEqual(validate_response(self.response({'d': [], 't': []}), self.batch), [])
        result = validate_response(self.response({'d': [], 't': [[7, '正文']]}), self.batch)
        self.assertEqual(result[0]['cleaned_line'], '正文')
    def test_invalid_responses_stop(self):
        cases = [({'d': [9], 't': []}, 'stop'), ({'d': [7, 7], 't': []}, 'stop'),
                 ({'d': [], 't': [[7, '新正文']]}, 'stop'), ({'d': [], 't': []}, 'length'),
                 ({'d': []}, 'stop')]
        for value, reason in cases:
            with self.subTest(value=value, reason=reason), self.assertRaises(ValueError):
                validate_response(self.response(value, reason), self.batch)

    def test_narration_false_positive_drop_guard(self):
        from Jormungandr.hardmodel.chapter_cleaner import RawNovelBook
        book = RawNovelBook('unused', book_id='id000001')
        for text in ['如今只要在山顶上架起瞭望镜，便能看到远方。',
                     '能进入城堡的贵族，基本都是三大家族的支持者。']:
            self.assertFalse(book._is_safe_llm_drop({'line': text, 'prose_score': 1}))
        self.assertTrue(book._is_safe_llm_drop({'line': '感谢读者的支持，请投月票。', 'prose_score': 1}))

if __name__ == '__main__': unittest.main()
