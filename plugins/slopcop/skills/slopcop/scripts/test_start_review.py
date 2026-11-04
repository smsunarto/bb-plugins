"""CLI contract tests; the fake bb records calls and never dispatches agents."""

import contextlib
import io
import json
import os
import hashlib
import re
import shutil
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('start_review.py')
FAKE_BB = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
event = {'args': args, 'cwd': os.getcwd()}
if args[:2] == ['thread', 'spawn']:
    path = pathlib.Path(args[args.index('--prompt-file') + 1])
    event.update(prompt=path.read_text(), path=str(path))
    title = args[args.index('--title') + 1]
    lens = title.split()[1] if title.startswith('Lens ') else ''
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write(json.dumps(event) + '\n')
mode = os.environ.get('FAIL_MODE')
if args[:2] == ['review', 'prompt']:
    if mode == 'format':
        print('formatter failed', file=sys.stderr)
        sys.exit(3)
    if mode != 'empty':
        print('SHARED BRIEF\n' + args[args.index('--request') + 1])
else:
    provider = args[args.index('--provider') + 1]
    if mode == 'timeout-' + provider:
        import time
        time.sleep(5)
    if mode == provider or mode == 'lens-' + lens:
        print('launch failed', file=sys.stderr)
        sys.exit(4)
    if mode == 'malformed-' + provider:
        print('{}')
    else:
        print(json.dumps({'id': 'thr_' + provider + ('_' + lens if lens else '')}))
'''


class StartReviewTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.checkout = self.root / 'checkout with spaces; $(nope)'
        self.checkout.mkdir()
        (self.checkout / '.git').mkdir()
        self.context = self.root / 'context.txt'
        self.context.write_text('Repo guidance: `no shell` $(touch PWNED)\nSecond line ☃')
        self.fake = self.root / 'bb'
        self.fake.write_text(FAKE_BB)
        self.fake.chmod(0o755)
        self.log = self.root / 'calls.jsonl'
        self.env = dict(os.environ, BB_CLI=str(self.fake), CALL_LOG=str(self.log),
                        BB_PROJECT_ID='proj_test', BB_ENVIRONMENT_ID='env_test', BB_THREAD_ID='thr_parent')
        self.args = ['--repository', 'owner/repo', '--pr-number', '42',
                     '--base-sha', 'a' * 40, '--head-sha', 'b' * 40,
                     '--checkout', str(self.checkout), '--context-file', str(self.context)]

    def run_script(self, args=None, mode=None):
        env = dict(self.env)
        if mode:
            env['FAIL_MODE'] = mode
        completed = subprocess.run([sys.executable, str(SCRIPT), *(self.args if args is None else args)],
                                   capture_output=True, text=True, env=env)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return completed, calls

    def test_success_and_argument_safety(self):
        completed, calls = self.run_script()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        data = json.loads(completed.stdout)
        self.assertTrue(data['ok'])
        self.assertEqual([x['thread_id'] for x in data['launches']], ['thr_claude-code', 'thr_codex'])
        self.assertEqual(len(calls), 2)
        first, second = calls
        self.assertNotEqual(first['prompt'], second['prompt'])
        self.assertIn(self.context.read_text(), first['prompt'])
        self.assertTrue(first['prompt'].startswith('# Pinned source'))
        self.assertIn('a' * 40, first['prompt'])
        self.assertIn('b' * 40, first['prompt'])
        self.assertIn('report-only', first['prompt'].lower())
        for call, provider in zip(calls, ('claude-code', 'codex')):
            args = call['args']
            self.assertEqual(call['cwd'], str(self.checkout))
            for flag, value in [('--provider', provider), ('--project', 'proj_test'),
                                ('--environment', 'env_test'), ('--parent-thread', 'thr_parent'),
                                ('--reasoning-level', 'high'), ('--parent-notifications', 'auto')]:
                self.assertEqual(args[args.index(flag) + 1], value)
            self.assertIn('owner/repo#42', args[args.index('--title') + 1])
            self.assertNotIn('--permission-mode', args)
            self.assertNotIn('--model', args)
            self.assertFalse(Path(call['path']).exists())
            self.assertFalse(Path(call['path']).parent.exists())

    def test_partial_failure_preserves_survivor_and_cleans_prompt(self):
        for mode in ('claude-code', 'codex', 'malformed-claude-code'):
            with self.subTest(mode=mode):
                if self.log.exists():
                    self.log.unlink()
                completed, calls = self.run_script(mode=mode)
                self.assertEqual(completed.returncode, 1)
                result = json.loads(completed.stdout)
                self.assertFalse(result['ok'])
                self.assertEqual(len(result['launches']), 2)
                self.assertEqual(len(calls), 2)
                survivor = 0 if mode == 'codex' else 1
                self.assertTrue(result['launches'][survivor]['thread_id'])
                self.assertIn('error', result['launches'][1 - survivor])
                self.assertTrue(all(not Path(call['path']).exists() for call in calls))

    def test_invalid_inputs_never_call_bb(self):
        for flag, value in [('--repository', 'bad'), ('--pr-number', '0'), ('--pr-number', '-1'),
                            ('--base-sha', 'main'), ('--head-sha', 'b' * 39),
                            ('--checkout', str(self.root / 'missing')), ('--checkout', str(self.root)),
                            ('--context-file', str(self.root / 'missing')), ('--project', ''), ('--provider', 'codex'), ('--lens', 'A'),
                            ('--environment', '--bad'), ('--parent-thread', '\n')]:
            with self.subTest(flag=flag, value=value):
                args = self.args.copy()
                if flag in args:
                    args[args.index(flag) + 1] = value
                else:
                    args.extend([flag, value])
                completed, calls = self.run_script(args)
                self.assertEqual(completed.returncode, 2)
                self.assertEqual(calls, [])

    def test_help_never_calls_bb(self):
        completed, calls = self.run_script(['--help'])
        self.assertEqual(completed.returncode, 0)
        self.assertIn('--context-file', completed.stdout)
        self.assertEqual(calls, [])

    def test_routing_overrides_and_optional_context(self):
        args = self.args[:-2] + ['--project', 'proj_other', '--environment', 'env_other', '--parent-thread', 'thr_other']
        completed, calls = self.run_script(args)
        self.assertEqual(completed.returncode, 0)
        result = json.loads(completed.stdout)
        self.assertEqual((result['project'], result['environment'], result['parent_thread']),
                         ('proj_other', 'env_other', 'thr_other'))
        self.assertNotIn(self.context.read_text(), calls[0]['prompt'])
        for call in calls:
            for flag, value in [('--project', 'proj_other'), ('--environment', 'env_other'),
                                ('--parent-thread', 'thr_other')]:
                self.assertEqual(call['args'][call['args'].index(flag) + 1], value)

    def test_timeout_preserves_survivor_and_cleans_prompt(self):
        main = runpy.run_path(str(SCRIPT))['main']
        main.__globals__['COMMAND_TIMEOUT_SECONDS'] = 0.5
        output = io.StringIO()
        with patch.dict(os.environ, dict(self.env, FAIL_MODE='timeout-codex')), contextlib.redirect_stdout(output):
            status = main(self.args)
        result = json.loads(output.getvalue())
        self.assertEqual(status, 1)
        self.assertEqual(result['launches'][0]['thread_id'], 'thr_claude-code')
        self.assertIn('timed out', result['launches'][1]['error'])
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertTrue(all(not Path(call['path']).exists() for call in calls))

    def test_lenses_match_provider_and_preserve_preferences(self):
        profile = (SCRIPT.parent.parent / 'references/review_profile.md').read_bytes()
        appendix = (SCRIPT.parent.parent / 'references/appendix.md').read_bytes()
        for provider in ('claude-code', 'codex'):
            self.log.unlink(missing_ok=True)
            completed, calls = self.run_script(self.args + ['--mode', 'lenses', '--provider', provider])
            self.assertEqual(completed.returncode, 0, completed.stderr)
            data = json.loads(completed.stdout)
            self.assertEqual([x['lens_id'] for x in data['launches']], list('ABCDEFGHJKI'))
            self.assertEqual(len(calls), 11)
            for call, launch in zip(calls, data['launches']):
                self.assertEqual(launch['role'], 'lens')
                self.assertEqual(launch['provider'], provider)
                self.assertEqual(call['args'][call['args'].index('--parent-thread') + 1], 'thr_parent')
                self.assertEqual(call['args'][call['args'].index('--lifecycle-owner-thread') + 1], 'thr_parent')
                prompt = call['prompt'].encode()
                self.assertTrue(prompt.endswith(profile + appendix))
                self.assertIn(b'Do not read existing PR reviews, review comments, or review discussions written by other humans or agents.', prompt)
                self.assertIn(b'Do not inspect GitHub CI checks, commit statuses, workflow runs, logs, or artifacts.', prompt)
                self.assertIn(b'Pass these restrictions to every reviewer, lens, and tool subagent', prompt)
                self.assertIn(b'You may use tool subagents', prompt[:prompt.index(profile)])
                self.assertIn(b'DO NOT create BB subthreads', prompt[:prompt.index(profile)])
                self.assertIn(b'Do not message peers or parents', prompt[:prompt.index(profile)])
                self.assertIn(b'ending your turn with the final report', prompt[:prompt.index(profile)])
                self.assertEqual(call['args'][call['args'].index('--parent-notifications') + 1], 'auto')
                self.assertNotIn(b'```sh', prompt[:prompt.index(profile)])
                self.assertIn(('- **Lens ' + launch['lens_id']).encode(), prompt[:prompt.index(profile)])
                self.assertFalse(Path(call['path']).exists())

    def test_reviewer_command_runs_after_temporary_cleanup(self):
        completed, calls = self.run_script()
        profile = (SCRIPT.parent.parent / 'references/review_profile.md').read_bytes()
        appendix = (SCRIPT.parent.parent / 'references/appendix.md').read_bytes()
        self.assertEqual(completed.returncode, 0)
        for call in calls:
            self.assertTrue(call['prompt'].encode().endswith(profile))
            self.assertNotIn(appendix, call['prompt'].encode())
            self.assertIn('only by ending your turn with your report', call['prompt'])
            self.assertIn('Do not read existing PR reviews, review comments, or review discussions written by other humans or agents.', call['prompt'])
            self.assertIn('Do not inspect GitHub CI checks, commit statuses, workflow runs, logs, or artifacts.', call['prompt'])
            self.assertIn('<!-- slopcop:awaiting-children -->', call['prompt'])
            self.assertIn('end your turn with only', call['prompt'])
            self.assertIn('remain idle', call['prompt'])
            self.assertNotIn('clock.sleep', call['prompt'])
            self.assertNotIn('bb thread wait <id> --timeout', call['prompt'])
            self.assertIn('Do not message peers, parents, or lens children', call['prompt'])
            self.assertEqual(call['args'][:2], ['thread', 'spawn'])
            command = re.search(r'```sh\n(.*?)\n```', call['prompt'], re.S)[1]
            self.log.unlink()
            env = dict(self.env, BB_THREAD_ID='thr_actual_reviewer')
            launched = subprocess.run(['bash', '-c', command], env=env, cwd=self.checkout, text=True, capture_output=True)
            self.assertEqual(launched.returncode, 0, launched.stderr)
            lenses = [json.loads(x) for x in self.log.read_text().splitlines()]
            self.assertEqual(len(lenses), 11)
            self.assertNotIn('--checkout', command)
            for lens in lenses:
                self.assertEqual(lens['cwd'], str(self.checkout))
                argv = lens['args']
                self.assertEqual(argv[argv.index('--parent-thread') + 1], 'thr_actual_reviewer')
                self.assertEqual(argv[argv.index('--provider') + 1], call['args'][call['args'].index('--provider') + 1])
                self.assertIn(self.context.read_text(), lens['prompt'])
            self.assertFalse((self.checkout / 'PWNED').exists())

    def test_partial_lens_failure_and_targeted_recovery(self):
        args = self.args + ['--mode', 'lenses', '--provider', 'codex']
        completed, calls = self.run_script(args, mode='lens-D')
        self.assertEqual(completed.returncode, 1)
        launches = json.loads(completed.stdout)['launches']
        self.assertEqual(len(launches), 11)
        self.assertEqual(sum(bool(x['thread_id']) for x in launches), 10)
        self.assertIn('error', launches[3])
        self.assertTrue(all(not Path(x['path']).exists() for x in calls))
        self.log.unlink()
        completed, calls = self.run_script(args + ['--lens', 'D'])
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(json.loads(completed.stdout)['launches'][0]['lens_id'], 'D')

    def test_approved_asset_integrity(self):
        expected = {
            'review_profile.md': '7b26f129f8c42fd9438fb9b7c01eed668dcdd5c8f9144cd0d4258cc815a703e6',
            'appendix.md': '8795064276c30a97498e3438fb7c8ef49fd5653751b02fe7b7a8211c2fc6165e',
        }
        for name, digest in expected.items():
            self.assertEqual(hashlib.sha256((SCRIPT.parent.parent / 'references' / name).read_bytes()).hexdigest(), digest)

    def test_copied_skill_is_self_contained(self):
        installed = self.root / 'installed skill'
        shutil.copytree(SCRIPT.parent.parent, installed)
        completed = subprocess.run([sys.executable, str(installed / 'scripts/start_review.py'), *self.args],
                                   env=self.env, text=True, capture_output=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn(str(installed), self.log.read_text())
        package = json.loads((SCRIPT.parents[3] / 'package.json').read_text())
        self.assertIn('skills/', package['files'])

    def test_defaults_to_orchestrator_worktree(self):
        (self.checkout / '.git').rmdir()
        (self.checkout / '.git').write_text('gitdir: /shared/repo/.git/worktrees/review\n')
        args = self.args.copy()
        index = args.index('--checkout')
        del args[index:index + 2]
        completed = subprocess.run([sys.executable, str(SCRIPT), *args],
                                   cwd=self.checkout, env=self.env, text=True, capture_output=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertEqual(result['target']['checkout'], str(self.checkout))
        for line in self.log.read_text().splitlines():
            call = json.loads(line)
            self.assertEqual(call['cwd'], str(self.checkout))
            argv = call['args']
            self.assertEqual(argv[argv.index('--environment') + 1], 'env_test')

    def test_role_templates_control_asset_placement(self):
        installed = self.root / 'template skill'
        shutil.copytree(SCRIPT.parent.parent, installed)
        profile = (installed / 'references/review_profile.md').read_text()
        appendix = (installed / 'references/appendix.md').read_text()
        for mode, role, slots in (
            ('reviewers', 'reviewer-role.md', '{review_profile}'),
            ('lenses', 'lens-role.md', '{review_profile}{appendix}'),
        ):
            with self.subTest(mode=mode):
                self.log.unlink(missing_ok=True)
                (installed / 'references' / role).write_text(
                    '{checkout_instructions}\nBEFORE\n' + slots + '\nAFTER {{literal}}\n')
                args = self.args + ['--mode', mode]
                if mode == 'lenses':
                    args += ['--provider', 'codex', '--lens', 'A']
                completed = subprocess.run([sys.executable, str(installed / 'scripts/start_review.py'), *args],
                                           env=self.env, text=True, capture_output=True)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                expected = profile + (appendix if mode == 'lenses' else '')
                for line in self.log.read_text().splitlines():
                    prompt = json.loads(line)['prompt']
                    self.assertIn('BEFORE\n' + expected + '\nAFTER {literal}\n', prompt)
                    self.assertEqual(prompt.count(profile), 1)
                    self.assertEqual(prompt.count(appendix), 1 if mode == 'lenses' else 0)

    def test_missing_defaults_never_calls_bb(self):
        for name in ('BB_PROJECT_ID', 'BB_ENVIRONMENT_ID', 'BB_THREAD_ID'):
            with self.subTest(name=name):
                value = self.env.pop(name)
                completed, calls = self.run_script()
                self.env[name] = value
                self.assertEqual(completed.returncode, 2)
                self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
