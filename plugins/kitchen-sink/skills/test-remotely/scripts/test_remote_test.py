import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('remote_test', Path(__file__).with_name('remote_test.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class RemoteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_artifact_roundtrip_modes_links_and_binary(self):
        source = self.root / 'source'
        source.mkdir()
        (source / 'run').write_bytes(b'changed\0binary')
        (source / 'run').chmod(0o755)
        (source / 'alias').symlink_to('run')
        (source / '.env').write_text('secret')
        archive = self.root / 'snapshot.tar.gz'
        r.pack(source, archive, ['run', 'alias'])
        destination = self.root / 'destination'
        r.extract(archive, destination)
        self.assertEqual((destination / 'run').read_bytes(), b'changed\0binary')
        self.assertEqual((destination / 'run').stat().st_mode & 0o777, 0o755)
        self.assertEqual((destination / 'alias').readlink(), Path('run'))
        self.assertFalse((destination / '.env').exists())
        with self.assertRaises(FileExistsError):
            r.extract(archive, destination)

    def test_unsafe_source_paths_fail_closed(self):
        (self.root / 'external').symlink_to('/etc/passwd')
        for name in ['../escape', '/absolute', '.git/config', '.env', 'external']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                r.pack(self.root, self.root / 'payload.tar.gz', [name])

    def test_archive_cannot_escape_or_write_through_links(self):
        for index, entries in enumerate([
            [('../escape', None), ('safe', None)],
            [('link', '/tmp')],
            [('link', 'directory'), ('link/file', None)],
            [('same', None), ('same', None)],
        ]):
            archive = self.root / f'{index}.tar.gz'
            with tarfile.open(archive, 'w:gz') as tar:
                for name, link in entries:
                    info = tarfile.TarInfo(name)
                    if link:
                        info.type = tarfile.SYMTYPE
                        info.linkname = link
                    tar.addfile(info)
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                r.extract(archive, self.root / f'extract-{index}')

    def test_chunked_transfer_checks_integrity_before_extract(self):
        source = self.root / 'evidence'
        source.mkdir()
        (source / 'demo.bin').write_bytes(bytes(range(256)) * 10)
        store = {}
        corrupt = False

        def fake_bb(*args):
            path = Path(args[args.index('--client-file') + 1])
            if args[2] == 'upload':
                key = f'uploads/{len(store)}'
                store[key] = path.read_bytes()
                return {'path': key}
            path.write_bytes(b'bad' if corrupt else store[args[4]])
            return {}

        with patch.object(r, 'bb', side_effect=fake_bb), patch.object(r, 'CHUNK', 100):
            transfer = r.publish(source, self.root / 'transfer', 'project')
            self.assertGreater(len(transfer['parts']), 1)
            result = r.receive(self.root / 'transfer/transfer.json', self.root / 'copy')
            self.assertEqual(result['sha256'], transfer['sha256'])
            self.assertEqual((self.root / 'copy/demo.bin').read_bytes(), (source / 'demo.bin').read_bytes())
            corrupt = True
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                r.receive(self.root / 'transfer/transfer.json', self.root / 'corrupt')
            self.assertFalse((self.root / 'corrupt').exists())

    def test_capacity_and_exclusive_resources(self):
        sample = {'cpus': 32, 'load1': 2, 'memory_gib': 64, 'available_gib': 50}
        claim = {'cpus': 4, 'memory_gib': 8, 'resources': ['desktop']}
        self.assertIsNone(r.admission(sample, [claim], 4, 8, ['browser-a']))
        self.assertEqual(r.admission(sample, [claim], 4, 8, ['desktop']), 'resource-conflict')
        self.assertEqual(r.admission(sample, [claim], 4, 8, ['machine-setup']), 'resource-conflict')
        setup = {**claim, 'resources': ['machine-setup']}
        self.assertEqual(r.admission(sample, [setup], 4, 8, []), 'resource-conflict')
        self.assertEqual(r.admission(sample, [claim], 24, 8, []), 'cpu-reservations')
        self.assertEqual(r.admission({**sample, 'load1': 24}, [], 4, 8, []), 'cpu-load')
        self.assertEqual(r.admission(sample, [], 4, 45, []), 'memory-capacity')

    def test_reservation_owner_and_no_automatic_expiry(self):
        sample = {'cpus': 32, 'load1': 0, 'memory_gib': 64, 'available_gib': 60}
        args = argparse.Namespace(action='claim', run='a', cpus=4, memory_gib=8, resource=[])
        with patch.object(Path, 'home', return_value=self.root), patch.object(r, 'capacity', return_value=sample):
            with patch.dict(os.environ, BB_THREAD_ID='owner'):
                self.assertTrue(r.reservations(args)['admitted'])
                with self.assertRaisesRegex(ValueError, 'already reserved'):
                    r.reservations(args)
            args.action = 'release'
            with patch.dict(os.environ, BB_THREAD_ID='other'):
                with self.assertRaisesRegex(ValueError, 'owning thread'):
                    r.reservations(args)
            with patch.dict(os.environ, BB_THREAD_ID='owner'):
                self.assertEqual(r.reservations(args)['reservations'], {})

    def test_launch_requires_auth_and_mac_reason_before_upload(self):
        args = argparse.Namespace(machine='codex@cardinal', mac_reason=None)
        with patch.dict(os.environ, BB_THREAD_ID='parent'), patch.object(r, 'bb', return_value=[]):
            with self.assertRaisesRegex(ValueError, 'connection/authentication'):
                r.launch(args)
        args.machine = 'Dev Mac'
        with patch.dict(os.environ, BB_THREAD_ID='parent'), patch.object(r, 'bb', return_value=[
            {'id': 'mac', 'name': 'Dev Mac', 'status': 'connected'}
        ]) as calls:
            with self.assertRaisesRegex(ValueError, 'mac-reason'):
                r.launch(args)
            self.assertEqual(calls.call_count, 1)

    def test_reject_nonfinite_budgets(self):
        for n in ['0', '-1', 'nan', 'inf']:
            with self.assertRaises(argparse.ArgumentTypeError):
                r.positive(n)

    def test_concurrent_claims_do_not_overbook(self):
        sample = {'cpus': 32, 'load1': 0, 'memory_gib': 64, 'available_gib': 60}
        def claim(run):
            return r.reservations(argparse.Namespace(action='claim', run=run, cpus=16,
                                                    memory_gib=8, resource=[]))['admitted']
        with patch.object(Path, 'home', return_value=self.root), patch.object(r, 'capacity', return_value=sample), \
             patch.dict(os.environ, BB_THREAD_ID='worker'), ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(claim, ['a', 'b'])), [False, True])

    def test_launch_handoff_keeps_remote_model_and_pinned_commits(self):
        repo = self.root / 'repo'
        repo.mkdir()
        task = self.root / 'task.md'
        task.write_text('Test the edited app and capture it.')
        args = argparse.Namespace(machine='codex@cardinal', mac_reason=None, repo=str(repo),
                                  out=str(self.root / 'out'), task=str(task), branch='scott/test', base='origin/main',
                                  remote='origin', main_reason=None)
        launches = []
        def fake_bb(*a):
            if a[:2] == ('machine', 'list'):
                return [{'id': 'host-cardinal', 'name': 'codex@cardinal', 'status': 'connected'}]
            if a[:2] == ('provider', 'models'):
                return [{'id': r.MODEL, 'supportedReasoningEfforts': [{'reasoningEffort': 'low'}]}]
            if a == ('status',):
                return {'project': {'id': 'source-project'}, 'thread': {'id': 'parent'}}
            if a[:2] == ('project', 'list'):
                return [{'id': 'personal-project', 'kind': 'personal'}]
            if a[:3] == ('project', 'attachment', 'upload'):
                return {'path': 'attachment-token'}
            launches.append(a)
            return {'id': 'remote-child'}
        with patch.dict(os.environ, BB_THREAD_ID='parent'), patch.object(r, 'bb', side_effect=fake_bb), \
             patch.object(r, 'command', return_value=str(repo)), \
             patch.object(r, 'git_source', return_value={'head': 'a' * 40, 'base': 'b' * 40}):
            result = r.launch(args)
        launch = launches[0]
        self.assertIn('--parent-self', launch)
        for flag, expected in [('--project', 'personal-project'), ('--machine', 'host-cardinal'),
                               ('--provider', 'codex'), ('--model', 'gpt-6-astra'),
                               ('--reasoning-level', 'low')]:
            self.assertEqual(launch[launch.index(flag) + 1], expected)
        source = json.loads(Path(result['source']).read_text())
        self.assertEqual(source, {'head': 'a' * 40, 'base': 'b' * 40})
        self.assertNotIn('source transfer', launch[launch.index('--prompt') + 1])

    def source_file(self):
        source = self.root / 'source.json'
        data = {'version': 1, 'remote': 'https://github.com/smsunarto/example.git',
                'branch': 'scott/test', 'head': 'a' * 40, 'base': 'b' * 40,
                'initial_head': 'a' * 40, 'main_reason': None}
        source.write_text(json.dumps(data))
        return source, data

    def test_main_exception_requires_exact_github_owner_and_reason(self):
        r.validate_branch('scott/test', 'https://github.com/other/example.git', 'origin', None)
        for url in ['https://github.com/smsunarto/example.git', 'git@github.com:smsunarto/example.git']:
            r.validate_branch('main', url, 'origin', 'Required by this test integration')
        for branch, url, reason in [
            ('main', 'https://github.com/other/example.git', 'required'),
            ('main', 'https://github.com/smsunarto-other/example.git', 'required'),
            ('main', 'https://elsewhere.com/smsunarto/example.git', 'required'),
            ('main', 'https://github.com/smsunarto/example.git', None),
            ('master', 'https://github.com/smsunarto/example.git', 'required'),
        ]:
            with self.subTest(url=url, branch=branch, reason=reason), self.assertRaises(ValueError):
                r.validate_branch(branch, url, 'origin', reason)

    def test_source_push_pins_commit_and_merge_base(self):
        head, base = 'a' * 40, 'b' * 40
        url = 'https://github.com/smsunarto/example.git'
        with patch.object(r, 'command', side_effect=['scott/test', head, base, base, url,
                                                    f'{head}\trefs/heads/scott/test\n']), \
             patch.object(r, 'push_branch') as push:
            data = r.git_source(self.root, 'scott/test', 'origin/main', 'origin')
        self.assertEqual(data['head'], head)
        self.assertEqual(data['base'], base)
        push.assert_called_once_with(self.root, 'scott/test', 'origin', url)

    def test_main_guard_runs_before_push(self):
        with patch.object(r, 'command', side_effect=['main', 'a' * 40, 'b' * 40, 'b' * 40,
                                                    'https://github.com/other/example.git']) as calls:
            with self.assertRaises(ValueError):
                r.git_source(self.root, 'main', 'origin/main', 'origin', 'required')
            self.assertFalse(any(c.args[0] == 'but' for c in calls.call_args_list))

    def test_checkout_refuses_moved_branch_and_reused_directory(self):
        source, data = self.source_file()
        with patch.object(r, 'command', side_effect=['scott/test', '', 'c' * 40]):
            with self.assertRaisesRegex(ValueError, 'does not match'):
                r.checkout_source(source, self.root / 'checkout')
        with self.assertRaisesRegex(ValueError, 'new directory'):
            r.checkout_source(source, self.root)
        with patch.object(r, 'command', side_effect=['scott/test', '', data['head'], '', 'fix issue', 'app | 1 +']) as calls:
            result = r.checkout_source(source, self.root / 'checkout')
        self.assertEqual(result['head'], data['head'])
        self.assertEqual(result['recent_commits'], 'fix issue')
        self.assertIn('--branch', calls.call_args_list[1].args)
        self.assertNotIn('--depth', calls.call_args_list[1].args)

    def test_revision_reuses_idle_child_at_astra_high(self):
        task = self.root / 'fix.md'
        task.write_text('Fix the observed failure and retest.')
        thread = {'parentThreadId': 'parent', 'providerId': 'codex', 'status': 'idle'}
        with patch.object(r, 'bb', side_effect=[{'thread': {'id': 'parent'}}, {'thread': thread}, {'ok': True}]) as calls:
            r.revise('existing-child', task)
        args = calls.call_args_list[-1].args
        self.assertEqual(args[:3], ('thread', 'tell', 'existing-child'))
        self.assertEqual(args[args.index('--model') + 1], 'gpt-6-astra')
        self.assertEqual(args[args.index('--reasoning-level') + 1], 'high')
        for field, value in [('status', 'active'), ('parentThreadId', 'other'), ('providerId', 'claude-code')]:
            with patch.object(r, 'bb', side_effect=[{'thread': {'id': 'parent'}}, {'thread': {**thread, field: value}}]):
                with self.assertRaises(ValueError):
                    r.revise('existing-child', task)

    def test_publish_fix_checks_remote_ownership_and_advances_manifest(self):
        source, data = self.source_file()
        new = 'c' * 40
        outputs = [data['remote'], new, '', '', '', f"{data['head']}\trefs/heads/scott/test",
                   f'{new}\trefs/heads/scott/test']
        with patch.object(r, 'command', side_effect=outputs), patch.object(r, 'push_branch'):
            result = r.publish_fix(self.root, source)
        self.assertEqual(result['head'], new)
        self.assertEqual(result['initial_head'], data['initial_head'])
        source.write_text(json.dumps(data))
        with patch.object(r, 'command', side_effect=outputs[:5] + [f'{new}\trefs/heads/scott/test']) as calls:
            with self.assertRaisesRegex(ValueError, 'changed ownership'):
                r.publish_fix(self.root, source)
            self.assertFalse(any(c.args[0] == 'but' for c in calls.call_args_list))

    def test_sync_result_updates_once_without_overwriting_local_work(self):
        source, data = self.source_file()
        data['head'] = 'c' * 40
        source.write_text(json.dumps(data))
        with patch.object(r, 'command', side_effect=[data['remote'], 'd' * 40]) as calls:
            with self.assertRaisesRegex(ValueError, 'Local task branch changed'):
                r.sync_result(self.root, source)
            self.assertFalse(any(c.args[0] == 'but' for c in calls.call_args_list))
        with patch.object(r, 'command', side_effect=[data['remote'], data['initial_head'], '', data['head'], '',
                                                    'app\0', json.dumps({'uncommittedChanges': [], 'stacks': []}), 'clean preview', '', data['head']]):
            self.assertTrue(r.sync_result(self.root, source, apply=True)['updated'])
        with patch.object(r, 'command', side_effect=[data['remote'], data['head']]):
            self.assertFalse(r.sync_result(self.root, source)['updated'])


    def test_sync_default_only_previews(self):
        source, data = self.source_file()
        data['head'] = 'c' * 40
        source.write_text(json.dumps(data))
        with patch.object(r, 'command', side_effect=[data['remote'], data['initial_head'], '', data['head'], '',
                                                    'app\0', json.dumps({'uncommittedChanges': [], 'stacks': []}),
                                                    'conflict requiring review']) as calls:
            result = r.sync_result(self.root, source)
        self.assertFalse(result['updated'])
        self.assertEqual(result['preview'], 'conflict requiring review')
        self.assertIn('--dry-run', calls.call_args_list[-1].args)

    def test_push_preflight_blocks_wrong_destination_and_ancestor_changes(self):
        url = 'https://github.com/smsunarto/example.git'
        state = {'stacks': [{'branches': [{'name': 'scott/test'}]}]}
        with patch.object(r, 'command', side_effect=[json.dumps({'push_remote': 'fork'})]) as calls:
            with self.assertRaisesRegex(ValueError, 'push remote differs'):
                r.push_branch(self.root, 'scott/test', 'origin', url)
            self.assertFalse(any(c.args[:2] == ('but', 'push') for c in calls.call_args_list))
        with patch.object(r, 'command', side_effect=[json.dumps({'push_remote': 'origin'}),
                                                    'git@github.com:someone-else/example.git']) as calls:
            with self.assertRaisesRegex(ValueError, 'push URL differs'):
                r.push_branch(self.root, 'scott/test', 'origin', url)
        state['stacks'][0]['branches'].append({'name': 'other-work'})
        with patch.object(r, 'command', side_effect=[json.dumps({'push_remote': 'origin'}), url,
                                                    json.dumps(state), 'a' * 40, '']) as calls:
            with self.assertRaisesRegex(ValueError, 'ancestor branch'):
                r.push_branch(self.root, 'scott/test', 'origin', url)
            self.assertFalse(any(c.args[:2] == ('but', 'push') for c in calls.call_args_list))
        state['stacks'][0]['branches'].pop()
        with patch.object(r, 'command', side_effect=[json.dumps({'push_remote': 'origin'}),
                                                    'git@github.com:smsunarto/example.git', json.dumps(state), '', '']) as calls:
            r.push_branch(self.root, 'scott/test', 'origin', url)
        self.assertEqual(calls.call_args_list[-2].args, ('but', 'push', 'scott/test', '--dry-run'))
        self.assertEqual(calls.call_args_list[-1].args, ('but', 'push', 'scott/test'))

    def test_sync_result_stops_on_overlapping_uncommitted_edits(self):
        source, data = self.source_file()
        data['head'] = 'c' * 40
        source.write_text(json.dumps(data))
        state = {'uncommittedChanges': [{'filePath': 'app'}], 'stacks': []}
        with patch.object(r, 'command', side_effect=[data['remote'], data['initial_head'], '', data['head'], '',
                                                    'app\0', json.dumps(state)]) as calls:
            with self.assertRaisesRegex(ValueError, 'Uncommitted local changes overlap'):
                r.sync_result(self.root, source)
            self.assertFalse(any(c.args[:3] == ('but', 'branch', 'update') for c in calls.call_args_list))



if __name__ == '__main__':
    unittest.main()
