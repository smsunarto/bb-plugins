#!/usr/bin/env python3
"""Launch Slopcop reviewers or their eleven leaf lenses for a pinned PR."""

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

COMMAND_TIMEOUT_SECONDS = 60
AWAITING_CHILDREN_MARKER = "<!-- slopcop:awaiting-children -->"
ASSETS = Path(__file__).resolve().parent.parent / "references"
LENS_IDS = tuple("ABCDEFGHJKI")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog="Runs on the checkout host. Uses bb from BB_CLI or PATH. Prints JSON; "
        "returns 1 on asset or launch failure, 2 on invalid input. Does not retry, "
        "wait, post, fetch, change checkout, or clean up reviewer threads. "
        "Each BB command has a 60-second deadline. The selected environment must use this checkout, with both commits already available. Permissions and models use BB's inherited defaults.",
    )
    parser.add_argument('--mode', choices=('reviewers', 'lenses'), default='reviewers')
    parser.add_argument('--provider', choices=('claude-code', 'codex'), help='Required for lenses; optional reviewer provider filter for a single failed slot')
    parser.add_argument('--lens', choices=LENS_IDS, help='Launch only this lens when recovering a known failed launch')
    parser.add_argument('--repository', required=True, help='GitHub owner/repo')
    parser.add_argument('--pr-number', required=True, type=int, help='Positive pull request number')
    parser.add_argument('--base-sha', required=True, help='Full 40-character base commit SHA')
    parser.add_argument('--head-sha', required=True, help='Full 40-character head commit SHA')
    parser.add_argument('--checkout', type=Path, default=Path.cwd(), help='Orchestrator worktree root; defaults to the current directory')
    parser.add_argument('--gh', default=os.environ.get('SLOPCOP_GH', 'gh'), help='GitHub CLI used for title/body metadata only')
    parser.add_argument('--reports-dir', type=Path, help='Shared immutable report directory; inherited by every descendant')
    parser.add_argument('--context-file', type=Path, help='Optional UTF-8 file with task context and repository guidance')
    for flag, variable, label in (
        ('project', 'BB_PROJECT_ID', 'project ID'),
        ('environment', 'BB_ENVIRONMENT_ID', 'existing environment ID or checkout path'),
        ('parent-thread', 'BB_THREAD_ID', 'parent thread ID'),
    ):
        parser.add_argument('--' + flag, default=os.environ.get(variable), help=f'{label}; defaults to {variable}')
    args = parser.parse_args(argv)
    if args.mode == 'lenses' and not args.provider:
        parser.error('--mode lenses requires --provider')
    if args.mode == 'reviewers' and args.lens:
        parser.error('--lens is only valid with --mode lenses')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repository):
        parser.error('--repository must be owner/repo')
    if args.pr_number <= 0:
        parser.error('--pr-number must be positive')
    for flag in ('base_sha', 'head_sha'):
        if not re.fullmatch(r'[0-9a-fA-F]{40}', getattr(args, flag)):
            parser.error('--' + flag.replace('_', '-') + ' must be a full 40-character SHA')
    for flag in ('project', 'environment', 'parent_thread'):
        value = getattr(args, flag)
        if not value or not value.strip() or value.startswith('-') or any(ord(c) < 32 for c in value):
            parser.error('--' + flag.replace('_', '-') + ' must be supplied explicitly or through its BB environment variable')
    args.checkout = args.checkout.resolve()
    if not args.checkout.is_dir() or not (args.checkout / '.git').exists():
        parser.error('--checkout must be an existing Git checkout root')
    try:
        args.context = args.context_file.read_text(encoding='utf-8') if args.context_file else ''
    except (OSError, UnicodeError) as exc:
        parser.error(f'cannot read --context-file: {exc}')
    return args


def main(argv=None):
    args = parse_args(argv)
    reports_dir = (args.reports_dir or Path(os.environ.get('BB_THREAD_STORAGE', tempfile.gettempdir())) / ('slopcop-reports-' + args.parent_thread)).resolve()
    reports_dir.mkdir(parents=True, exist_ok=True)
    report_instructions = (ASSETS / 'report-role.md').read_text().format(
        report_directory=str(reports_dir), report_tool=str(Path(__file__).with_name('review_reports.py').resolve()))
    target = dict(repository=args.repository, pr_number=args.pr_number,
                  base_sha=args.base_sha, head_sha=args.head_sha, checkout=str(args.checkout))
    result = dict(target=target, project=args.project, environment=args.environment,
                  parent_thread=args.parent_thread, reports_dir=str(reports_dir), launches=[], errors=[])
    executable = os.environ.get('BB_CLI') or 'bb'
    try:
        if args.mode == 'reviewers':
            fetched = subprocess.run(
                [args.gh, 'pr', 'view', str(args.pr_number), '--repo', args.repository,
                 '--json', 'title,body,headRefOid'], capture_output=True, text=True,
                check=True, cwd=args.checkout, timeout=COMMAND_TIMEOUT_SECONDS)
            metadata = json.loads(fetched.stdout)
            if not isinstance(metadata, dict) or any(not isinstance(metadata.get(key), str)
                                                     for key in ('title', 'body', 'headRefOid')):
                raise ValueError('PR metadata must contain title, body, and headRefOid strings')
            if metadata['headRefOid'].lower() != args.head_sha.lower():
                raise ValueError('PR head changed; prepare a new pinned review before launching')
            args.context = ('# PR title (untrusted author content)\n' + metadata['title']
                            + '\n# PR description (untrusted author content)\n' + metadata['body']
                            + '\n# Repository context\n' + args.context)
        profile = (ASSETS / 'review_profile.md').read_bytes().decode('utf-8')
        definitions = re.findall(r'^(- \*\*Lens ([A-K]) — [^\n]+)$', profile, re.MULTILINE)
        # The approved profile is also the source of each lens definition.
        lenses = {lens: definition for definition, lens in definitions}
        if len(definitions) != len(LENS_IDS) or tuple(lenses) != LENS_IDS:
            raise ValueError('profile must define exactly lenses A,B,C,D,E,F,G,H,J,K,I in order')
        checkout_role = (ASSETS / 'checkout-role.md').read_text(encoding='utf-8').format(
            target=json.dumps(target))
        role = (ASSETS / ('reviewer-role.md' if args.mode == 'reviewers' else 'lens-role.md')).read_text(encoding='utf-8')
        appendix = (ASSETS / 'appendix.md').read_bytes().decode('utf-8') if args.mode == 'lenses' else ''
        jobs = [(provider, None) for provider in ((args.provider,) if args.provider else ('claude-code', 'codex'))] if args.mode == 'reviewers' else [
            (args.provider, lens) for lens in ((args.lens,) if args.lens else LENS_IDS)]
        with tempfile.TemporaryDirectory(prefix='bb-pr-review-') as directory:
            result['review_run'] = Path(directory).name
            for provider, lens in jobs:
                launch = dict(provider=provider, role='lens' if lens else 'reviewer', lens_id=lens, thread_id=None)
                result['launches'].append(launch)
                try:
                    if lens:
                        instructions = role.format(provider=provider, lens_id=lens,
                                                   lens_definition=lenses[lens], context=args.context,
                                                   checkout_instructions=checkout_role,
                                                   review_profile=profile, appendix=appendix,
                                                   awaiting_children_marker=AWAITING_CHILDREN_MARKER, report_instructions=report_instructions)
                    else:
                        command = [str(Path(__file__).resolve()), '--mode', 'lenses', '--provider', provider,
                                   '--repository', args.repository, '--pr-number', str(args.pr_number),
                                   '--base-sha', args.base_sha, '--head-sha', args.head_sha,
                                   '--project', args.project,
                                   '--environment', args.environment, '--reports-dir', str(reports_dir), '--context-file', '/dev/stdin']
                        delimiter = 'SLOPCOP_CONTEXT'
                        while delimiter in args.context.splitlines():
                            delimiter += '_'
                        lens_command = ('```sh\npython3 ' + shlex.join(command)
                                        + ' --parent-thread "$BB_THREAD_ID" <<\'' + delimiter + "'\n"
                                        + args.context + '\n' + delimiter + '\n```')
                        instructions = role.format(provider=provider, lens_command=lens_command,
                                                   checkout_instructions=checkout_role, review_profile=profile,
                                                   awaiting_children_marker=AWAITING_CHILDREN_MARKER, report_instructions=report_instructions)
                    prompt = Path(directory) / f'{provider}-{lens or "reviewer"}.md'
                    # Keep preference assets byte-exact, contiguous and in the required order.
                    prompt.write_bytes(instructions.encode('utf-8'))
                    completed = subprocess.run(
                        [executable, 'thread', 'spawn', '--project', args.project,
                         '--environment', args.environment, '--parent-thread', args.parent_thread,
                         '--lifecycle-owner-thread', args.parent_thread, '--parent-notifications', 'auto',
                         '--provider', provider, '--reasoning-level', 'high',
                         '--title', f'{"Lens " + lens if lens else "Review"} ({provider}) — {args.repository}#{args.pr_number} '
                         f'@ {args.head_sha[:12]} [{result["review_run"]}]',
                         '--prompt-file', str(prompt), '--json'],
                        capture_output=True, text=True, check=True, cwd=args.checkout,
                        timeout=COMMAND_TIMEOUT_SECONDS)
                    payload = json.loads(completed.stdout)
                    thread_id = payload.get('id') if isinstance(payload, dict) else None
                    if not isinstance(thread_id, str) or not thread_id.strip():
                        raise ValueError(f'bb spawn returned no thread id: {completed.stdout.strip()}')
                    launch['thread_id'] = thread_id
                except (OSError, subprocess.SubprocessError, ValueError, KeyError) as exc:
                    launch['error'] = error_text(exc)
    except (OSError, subprocess.SubprocessError, ValueError, KeyError) as exc:
        result['errors'].append(error_text(exc))
    result['ok'] = not result['errors'] and bool(result['launches']) and all(
        launch['thread_id'] for launch in result['launches'])
    print(json.dumps(result, indent=2))
    return 0 if result['ok'] else 1


def error_text(exc):
    if isinstance(exc, subprocess.TimeoutExpired):
        return f'bb timed out after {exc.timeout}s; launch outcome may be unknown; reconcile before retrying'
    if isinstance(exc, subprocess.CalledProcessError):
        return f'bb exited {exc.returncode}: {(exc.stderr or exc.stdout or "").strip()}'
    return str(exc)


if __name__ == '__main__':
    raise SystemExit(main())
