"""Tests for sync.py. They use a fake network, so no request reaches Raindrop."""
import http.client
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault('RAINDROP_TEST_TOKEN', 'test-token')  # sync.py exits without a token

import sync  # noqa: E402


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def ok(payload):
    return FakeResponse(json.dumps(payload).encode('utf-8'))


class BrokenResponse:
    """A response whose body is cut off while it is read."""

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        raise http.client.IncompleteRead(b'partial')


class BrokenErrorBody(io.BytesIO):
    """An error body that is cut off while it is read."""

    def read(self, *args):
        raise http.client.IncompleteRead(b'partial')


class CallRetriesTests(unittest.TestCase):
    def setUp(self):
        self.sleep = mock.patch.object(sync.time, 'sleep').start()
        self.addCleanup(mock.patch.stopall)

    def test_network_error_then_success_is_retried(self):
        side_effects = [urllib.error.URLError('connection reset'), TimeoutError('timed out'), ok({'result': True})]
        with mock.patch.object(sync.urllib.request, 'urlopen', side_effect=side_effects) as urlopen:
            self.assertEqual(sync.call('GET', '/collections'), {'result': True})
        self.assertEqual(urlopen.call_count, 3)

    def test_network_error_after_all_attempts_is_a_runtime_error(self):
        with mock.patch.object(sync.urllib.request, 'urlopen', side_effect=urllib.error.URLError('no route')) as urlopen:
            with self.assertRaises(RuntimeError) as ctx:
                sync.call('PUT', '/raindrop/1', {})
        self.assertIn('network error after retries', str(ctx.exception))
        self.assertEqual(urlopen.call_count, 5)

    def test_truncated_body_is_retried(self):
        side_effects = [BrokenResponse(), ok({'result': True})]
        with mock.patch.object(sync.urllib.request, 'urlopen', side_effect=side_effects) as urlopen:
            self.assertEqual(sync.call('GET', '/collections'), {'result': True})
        self.assertEqual(urlopen.call_count, 2)

    def test_post_network_error_is_not_repeated(self):
        # The folder may already exist, so a second POST could create a duplicate.
        with mock.patch.object(sync.urllib.request, 'urlopen', side_effect=urllib.error.URLError('timeout')) as urlopen:
            with self.assertRaises(RuntimeError) as ctx:
                sync.call('POST', '/collection', {'title': 'Work'})
        self.assertIn('not retried', str(ctx.exception))
        self.assertEqual(urlopen.call_count, 1)

    def test_post_server_error_is_not_repeated(self):
        error = urllib.error.HTTPError('url', 500, 'Server Error', {}, io.BytesIO(b'oops'))
        with mock.patch.object(sync.urllib.request, 'urlopen', side_effect=error) as urlopen:
            with self.assertRaises(RuntimeError):
                sync.call('POST', '/collection', {'title': 'Work'})
        self.assertEqual(urlopen.call_count, 1)

    def test_server_error_with_truncated_body_is_retried(self):
        error = urllib.error.HTTPError('url', 503, 'Unavailable', {}, BrokenErrorBody(b''))
        with mock.patch.object(sync.urllib.request, 'urlopen', side_effect=error) as urlopen:
            with self.assertRaises(RuntimeError) as ctx:
                sync.call('PUT', '/raindrop/1', {})
        self.assertIn('failed after retries', str(ctx.exception))
        self.assertEqual(urlopen.call_count, 5)

    def test_client_error_with_truncated_body_is_a_runtime_error(self):
        error = urllib.error.HTTPError('url', 404, 'Not Found', {}, BrokenErrorBody(b''))
        with mock.patch.object(sync.urllib.request, 'urlopen', side_effect=error) as urlopen:
            with self.assertRaises(RuntimeError) as ctx:
                sync.call('GET', '/raindrop/1')
        self.assertIn('404', str(ctx.exception))
        self.assertEqual(urlopen.call_count, 1)

    def test_http_client_error_is_not_retried(self):
        error = urllib.error.HTTPError('url', 404, 'Not Found', {}, io.BytesIO(b'gone'))
        with mock.patch.object(sync.urllib.request, 'urlopen', side_effect=error) as urlopen:
            with self.assertRaises(RuntimeError):
                sync.call('GET', '/raindrop/1')
        self.assertEqual(urlopen.call_count, 1)


class ApplyContinuesTests(unittest.TestCase):
    def test_a_failed_bookmark_is_logged_and_the_run_continues(self):
        plan = {
            'new_collections': [],
            'changes': [
                {'id': 1, 'move': False, 'to_folder': 'Misc', 'tags_before': [], 'tags_after': ['a']},
                {'id': 2, 'move': False, 'to_folder': 'Misc', 'tags_before': [], 'tags_after': ['b']},
            ],
        }

        def fake_call(method, path, body=None):
            if path == '/raindrop/1':
                raise RuntimeError('PUT /raindrop/1 network error after retries: no route')
            return {'result': True}

        with tempfile.TemporaryDirectory() as tmp:
            log_path = os.path.join(tmp, 'sync-log.jsonl')
            with mock.patch.object(sync, 'LOG_PATH', log_path), \
                    mock.patch.object(sync, 'call', side_effect=fake_call) as call:
                sync.apply_plan(plan, {'Misc': 9})
            with open(log_path, encoding='utf-8') as f:
                entries = [json.loads(line) for line in f]
        self.assertEqual(call.call_count, 2, 'the second bookmark must still be updated')
        self.assertEqual([(e['id'], e['ok']) for e in entries], [(1, False), (2, True)])
        self.assertIn('network error', entries[0]['error'])


if __name__ == '__main__':
    unittest.main()
