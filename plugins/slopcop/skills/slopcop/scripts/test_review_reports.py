import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('review_reports.py')


class ReportsTest(unittest.TestCase):
    def test_published_report_survives_late_ack_and_duplicate_collection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'report.md'
            source.write_text('Complete report with evidence.\n')
            base = [sys.executable, str(SCRIPT), '--directory', str(root / 'reports'), '--thread', 'thr_child']
            def run(*args):
                return subprocess.run([*base, *args], capture_output=True, text=True)
            published = run('publish', '--file', str(source))
            self.assertEqual(published.returncode, 0, published.stderr)
            first = json.loads(run('collect', '--reader', 'thr_parent').stdout)
            self.assertFalse(first['already_collected'])
            self.assertEqual(Path(first['report']).read_text(), source.read_text())
            source.write_text('Thanks, already done.\n')
            self.assertNotEqual(run('publish', '--file', str(source)).returncode, 0)
            repeated = json.loads(run('collect', '--reader', 'thr_parent').stdout)
            self.assertTrue(repeated['already_collected'])
            self.assertEqual(Path(repeated['report']).read_text(), 'Complete report with evidence.\n')
            self.assertFalse(json.loads(run('collect', '--reader', 'thr_other').stdout)['already_collected'])

    def test_pending_and_nonfinal_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            base = [sys.executable, str(SCRIPT), '--directory', tmp, '--thread', 'thr_child']
            missing = subprocess.run([*base, 'collect', '--reader', 'thr_parent'], capture_output=True, text=True)
            self.assertEqual(missing.returncode, 2)
            self.assertEqual(json.loads(missing.stdout)['status'], 'pending')
            for text in ('', '<!-- slopcop:awaiting-children -->'):
                (p/'in.md').write_text(text)
                self.assertNotEqual(subprocess.run([*base, 'publish', '--file', str(p/'in.md')], capture_output=True).returncode, 0)
            self.assertFalse((p/'thr_child.md').exists())
