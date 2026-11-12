#!/usr/bin/env python3
"""Write one prompt file per Slopcop lens for the orchestrator's lens subagents."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

COMMAND_TIMEOUT_SECONDS = 60
ASSETS = Path(__file__).resolve().parent.parent / "references"
LENS_IDS = tuple("ABCDEFGHJKI")
# Mechanical, inventory-style lenses run on Sonnet; lenses that simulate
# behavior, trace contracts, or judge security and concurrency stay on Opus.
LENS_MODELS = {
    "A": "opus",
    "B": "sonnet",
    "C": "sonnet",
    "D": "sonnet",
    "E": "sonnet",
    "F": "opus",
    "G": "opus",
    "H": "opus",
    "J": "opus",
    "K": "sonnet",
    "I": "sonnet",
}
LENS_EFFORT = "high"
SHA = re.compile(r"[0-9a-fA-F]{40}")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog="Runs in the orchestrator worktree. Fetches the PR title and description with gh, "
        "verifies the pinned head, writes the prompts, and prints a JSON manifest of "
        "{lens, model, effort, prompt_file}. Launches nothing. Returns 1 on asset or "
        "metadata failure and 2 on invalid input.",
    )
    parser.add_argument('--repository', required=True, help='GitHub owner/repo')
    parser.add_argument('--pr-number', required=True, type=int, help='Positive pull request number')
    parser.add_argument('--base-sha', required=True, help='Full 40-character base commit SHA')
    parser.add_argument('--head-sha', required=True, help='Full 40-character head commit SHA')
    parser.add_argument('--since', help='Full SHA of the previously reviewed head; lenses review only the commits after it')
    parser.add_argument('--lens', choices=LENS_IDS, action='append', help='Write only these lenses (repeatable)')
    parser.add_argument('--checkout', type=Path, default=Path.cwd(), help='Orchestrator worktree root; defaults to the current directory')
    parser.add_argument('--gh', default=os.environ.get('SLOPCOP_GH', 'gh'), help='GitHub CLI used for title/body metadata only')
    parser.add_argument('--context-file', type=Path, help='Optional UTF-8 file with repository guidance')
    parser.add_argument('--output-dir', type=Path, help='Directory for the prompt files; defaults to thread storage')
    args = parser.parse_args(argv)
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repository):
        parser.error('--repository must be owner/repo')
    if args.pr_number <= 0:
        parser.error('--pr-number must be positive')
    for flag in ('base_sha', 'head_sha', 'since'):
        value = getattr(args, flag)
        if value is not None and not SHA.fullmatch(value):
            parser.error('--' + flag.replace('_', '-') + ' must be a full 40-character SHA')
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
    target = dict(repository=args.repository, pr_number=args.pr_number, base_sha=args.base_sha,
                  head_sha=args.head_sha, checkout=str(args.checkout))
    if args.since:
        target['reviewed_through'] = args.since
    output_dir = (args.output_dir or Path(os.environ.get('BB_THREAD_STORAGE', tempfile.gettempdir()))
                  / f'slopcop-lenses-{args.head_sha[:12]}').resolve()
    written: list[dict] = []
    errors: list[str] = []
    try:
        fetched = subprocess.run(
            [args.gh, 'pr', 'view', str(args.pr_number), '--repo', args.repository,
             '--json', 'title,body,headRefOid'], capture_output=True, text=True,
            check=True, cwd=args.checkout, timeout=COMMAND_TIMEOUT_SECONDS)
        metadata = json.loads(fetched.stdout)
        if not isinstance(metadata, dict) or any(not isinstance(metadata.get(key), str)
                                                 for key in ('title', 'body', 'headRefOid')):
            raise ValueError('PR metadata must contain title, body, and headRefOid strings')
        if metadata['headRefOid'].lower() != args.head_sha.lower():
            raise ValueError('PR head changed; review the new head instead')
        context = ('# PR title (untrusted author content)\n' + metadata['title']
                   + '\n# PR description (untrusted author content)\n' + metadata['body']
                   + '\n# Repository context\n' + args.context)
        profile = (ASSETS / 'review_profile.md').read_bytes().decode('utf-8')
        definitions = re.findall(r'^(- \*\*Lens ([A-K]) — [^\n]+)$', profile, re.MULTILINE)
        # The approved profile is also the source of each lens definition.
        lenses = {lens: definition for definition, lens in definitions}
        if len(definitions) != len(LENS_IDS) or tuple(lenses) != LENS_IDS:
            raise ValueError('profile must define exactly lenses A,B,C,D,E,F,G,H,J,K,I in order')
        review_range = (f'`git diff {args.since} {args.head_sha}`: only the commits pushed since the last review. '
                        f'The base revision {args.base_sha} still holds prior art'
                        if args.since else f'`git diff {args.base_sha} {args.head_sha}`')
        checkout_role = (ASSETS / 'checkout-role.md').read_text(encoding='utf-8').format(
            target=json.dumps(target), review_range=review_range)
        role = (ASSETS / 'lens-role.md').read_text(encoding='utf-8')
        appendix = (ASSETS / 'appendix.md').read_bytes().decode('utf-8')
        output_dir.mkdir(parents=True, exist_ok=True)
        for lens in args.lens or LENS_IDS:
            prompt = output_dir / f'lens-{lens}.md'
            # Keep preference assets byte-exact, contiguous and in the required order.
            prompt.write_bytes(role.format(
                lens_id=lens, lens_definition=lenses[lens], context=context,
                checkout_instructions=checkout_role, review_profile=profile,
                appendix=appendix).encode('utf-8'))
            written.append(dict(lens=lens, model=LENS_MODELS[lens], effort=LENS_EFFORT,
                                         prompt_file=str(prompt)))
    except (OSError, subprocess.SubprocessError, ValueError, KeyError) as exc:
        errors.append(error_text(exc))
    ok = not errors and bool(written)
    print(json.dumps(dict(target=target, prompts_dir=str(output_dir), lenses=written,
                          errors=errors, ok=ok), indent=2))
    return 0 if ok else 1


def error_text(exc):
    if isinstance(exc, subprocess.TimeoutExpired):
        return f'gh timed out after {exc.timeout}s'
    if isinstance(exc, subprocess.CalledProcessError):
        return f'gh exited {exc.returncode}: {(exc.stderr or exc.stdout or "").strip()}'
    return str(exc)


if __name__ == '__main__':
    raise SystemExit(main())
