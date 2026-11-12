"""CLI contract tests for the lens prompt helper; a fake gh records calls."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('start_review.py')
BASE = 'a' * 40
HEAD = 'b' * 40
SINCE = 'c' * 40
FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\n')
print(json.dumps({"title": "Original PR title",
                  "body": "Original description: `{literal}`",
                  "headRefOid": os.environ.get('FAKE_HEAD', '%s')}))
''' % HEAD


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
        self.gh = self.root / 'gh'
        self.gh.write_text(FAKE_GH)
        self.gh.chmod(0o755)
        self.log = self.root / 'calls.jsonl'
        self.out = self.root / 'prompts'
        self.env = dict(os.environ, SLOPCOP_GH=str(self.gh), CALL_LOG=str(self.log))
        self.args = ['--repository', 'owner/repo', '--pr-number', '42',
                     '--base-sha', BASE, '--head-sha', HEAD, '--checkout', str(self.checkout),
                     '--context-file', str(self.context), '--output-dir', str(self.out)]

    def run_script(self, extra=(), script=SCRIPT, env=None):
        completed = subprocess.run([sys.executable, str(script), *self.args, *extra],
                                   capture_output=True, text=True, env=env or self.env)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return completed, calls

    def assets(self, directory=SCRIPT.parent.parent):
        return ((directory / 'references/review_profile.md').read_text(),
                (directory / 'references/appendix.md').read_text())

    def test_writes_every_lens_with_its_model(self):
        completed, calls = self.run_script()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(calls, [['pr', 'view', '42', '--repo', 'owner/repo', '--json', 'title,body,headRefOid']])
        manifest = json.loads(completed.stdout)
        self.assertTrue(manifest['ok'])
        self.assertEqual([entry['lens'] for entry in manifest['lenses']], list('ABCDEFGHJKI'))
        models = {entry['lens']: entry['model'] for entry in manifest['lenses']}
        self.assertEqual({lens for lens, model in models.items() if model == 'sonnet'}, set('BCDEIK'))
        self.assertEqual({lens for lens, model in models.items() if model == 'opus'}, set('AFGHJ'))
        self.assertEqual({entry['effort'] for entry in manifest['lenses']}, {'high'})
        profile, appendix = self.assets()
        for entry in manifest['lenses']:
            prompt = Path(entry['prompt_file']).read_text()
            self.assertEqual(Path(entry['prompt_file']).parent, self.out)
            self.assertIn(f'You are lens {entry["lens"]}', prompt)
            self.assertIn(f'- **Lens {entry["lens"]} — ', prompt)
            self.assertIn(profile + appendix, prompt)
            self.assertEqual(prompt.count(profile), 1)
            self.assertIn('Original description: `{literal}`', prompt)
            self.assertIn('Repo guidance: `no shell` $(touch PWNED)\nSecond line ☃', prompt)
            self.assertIn(f'`git diff {BASE} {HEAD}`', prompt)
        self.assertFalse((self.checkout / 'PWNED').exists())

    def test_follow_up_reviews_only_new_commits(self):
        completed, _ = self.run_script(['--since', SINCE, '--lens', 'B', '--lens', 'J'])
        self.assertEqual(completed.returncode, 0, completed.stderr)
        manifest = json.loads(completed.stdout)
        self.assertEqual(manifest['target']['reviewed_through'], SINCE)
        self.assertEqual([entry['lens'] for entry in manifest['lenses']], ['B', 'J'])
        prompt = Path(manifest['lenses'][0]['prompt_file']).read_text()
        self.assertIn(f'`git diff {SINCE} {HEAD}`: only the commits pushed since the last review', prompt)
        self.assertIn(f'The base revision {BASE} still holds prior art', prompt)

    def test_moved_head_writes_nothing(self):
        completed, calls = self.run_script(env=dict(self.env, FAKE_HEAD='d' * 40))
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(len(calls), 1)
        self.assertIn('PR head changed', json.loads(completed.stdout)['errors'][0])
        self.assertFalse(self.out.exists())

    def test_invalid_inputs_never_call_gh(self):
        for flag, value in (('--repository', 'nope'), ('--pr-number', '0'),
                            ('--head-sha', 'abc'), ('--since', 'abc'), ('--lens', 'Z')):
            with self.subTest(flag=flag):
                args = self.args.copy()
                if flag in args:
                    args[args.index(flag) + 1] = value
                else:
                    args += [flag, value]
                completed = subprocess.run([sys.executable, str(SCRIPT), *args],
                                           capture_output=True, text=True, env=self.env)
                self.assertEqual(completed.returncode, 2)
                self.assertFalse(self.log.exists())

    def test_approved_asset_integrity(self):
        expected = {
            'review_profile.md': '91f767eb9e22e0cca3461103a07206cc4b6894e54a0d832830a03b199c60d050',
            'appendix.md': '8795064276c30a97498e3438fb7c8ef49fd5653751b02fe7b7a8211c2fc6165e',
        }
        for name, digest in expected.items():
            self.assertEqual(hashlib.sha256((SCRIPT.parent.parent / 'references' / name).read_bytes()).hexdigest(), digest)

    def test_copied_skill_is_self_contained(self):
        installed = self.root / 'installed skill'
        shutil.copytree(SCRIPT.parent.parent, installed)
        completed, _ = self.run_script(script=installed / 'scripts/start_review.py')
        self.assertEqual(completed.returncode, 0, completed.stderr)
        package = json.loads((SCRIPT.parents[3] / 'package.json').read_text())
        self.assertIn('skills/', package['files'])

    def test_role_template_controls_asset_placement(self):
        installed = self.root / 'template skill'
        shutil.copytree(SCRIPT.parent.parent, installed)
        profile, appendix = self.assets(installed)
        (installed / 'references/lens-role.md').write_text(
            '{checkout_instructions}\nBEFORE\n{review_profile}{appendix}\nAFTER {{literal}}\n')
        completed, _ = self.run_script(['--lens', 'A'], script=installed / 'scripts/start_review.py')
        self.assertEqual(completed.returncode, 0, completed.stderr)
        prompt = Path(json.loads(completed.stdout)['lenses'][0]['prompt_file']).read_text()
        self.assertIn('BEFORE\n' + profile + appendix + '\nAFTER {literal}\n', prompt)


if __name__ == '__main__':
    unittest.main()
