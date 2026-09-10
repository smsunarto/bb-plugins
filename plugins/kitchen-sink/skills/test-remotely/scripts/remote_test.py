#!/usr/bin/env python3
"""Git source handoff, BB evidence transfer, and host-local test reservations."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

CHUNK = 20 * 1024 * 1024  # Below BB's 25 MB attachment limit.
MODEL = 'gpt-6-astra'


def command(*args, cwd=None):
    return subprocess.check_output(args, text=True, cwd=cwd)


def bb(*args):
    return json.loads(command(os.environ.get('BB_CLI', 'bb'), *args, '--json'))


def save(path, data):
    Path(path).write_text(json.dumps(data, indent=2) + '\n')


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(CHUNK), b''):
            h.update(block)
    return h.hexdigest()


def safe_name(name):
    p = PurePosixPath(name)
    if not name or p.is_absolute() or any(x in ('', '.', '..') for x in name.split('/')):
        raise ValueError(f'Unsafe relative path: {name!r}')
    if '.git' in p.parts:
        raise ValueError('Git metadata is not transferred')
    return p


def sensitive(name):
    parts = PurePosixPath(name).parts
    return any(p in ('.ssh', '.aws', '.gnupg', '.npmrc', '.netrc', 'credentials.json',
                     'auth.json', 'id_rsa', 'id_ed25519') or p == '.env' or
               (p.startswith('.env.') and p not in ('.env.example', '.env.sample', '.env.template')) or
               p.endswith(('.pem', '.p12', '.pfx', '.key')) for p in parts)


def pack(root, output, names):
    """Build a file-only archive; reject traversal, external links and secret paths."""
    root = Path(root).resolve()
    with tarfile.open(output, 'w:gz', dereference=False) as tar:
        for name in sorted(set(names)):
            safe_name(name)
            if sensitive(name):
                raise ValueError(f'Credential-like path needs a safe source scope: {name}')
            path = root / name
            if not path.parent.resolve().is_relative_to(root):
                raise ValueError(f'Path escapes snapshot root: {name}')
            if not path.exists() and not path.is_symlink():
                raise ValueError(f'Artifact disappeared: {name}')
            info = tar.gettarinfo(str(path), arcname=name)
            if info.issym():
                if Path(info.linkname).is_absolute() or not path.resolve().is_relative_to(root):
                    raise ValueError(f'External symlink: {name}')
                tar.addfile(info)
            elif info.isfile():
                with path.open('rb') as f:
                    tar.addfile(info, f)
            else:
                raise ValueError(f'Expected a file, not a submodule/directory/device: {name}')


def extract(archive, destination):
    """Extract to a new directory; never follow links or overwrite a checkout."""
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=False)
    with tarfile.open(archive, 'r:gz') as tar:
        members = tar.getmembers()
        names = set()
        links = set()
        for m in members:
            safe_name(m.name)
            if m.name in names or not (m.isfile() or m.issym()):
                raise ValueError(f'Unsupported or duplicate archive entry: {m.name}')
            names.add(m.name)
            if m.issym():
                target = destination / Path(m.name).parent / m.linkname
                if Path(m.linkname).is_absolute() or not target.resolve().is_relative_to(destination.resolve()):
                    raise ValueError(f'Escaping symlink: {m.name}')
                links.add(m.name)
        for m in members:
            if any(str(p) in links for p in PurePosixPath(m.name).parents):
                raise ValueError(f'Archive writes through a symlink: {m.name}')
        for m in members:
            p = destination / m.name
            p.parent.mkdir(parents=True, exist_ok=True)
            if m.issym():
                p.symlink_to(m.linkname)
            else:
                with tar.extractfile(m) as source, p.open('xb') as target:
                    shutil.copyfileobj(source, target)
                p.chmod(m.mode & 0o777)


def upload(archive, directory, project):
    parts = []
    with Path(archive).open('rb') as source:
        while block := source.read(CHUNK):
            piece = Path(directory) / f'part-{len(parts):04d}.bin'
            piece.write_bytes(block)
            dto = bb('project', 'attachment', 'upload', project, '--client-file', str(piece),
                     '--mime-type', 'application/octet-stream')
            parts.append({'path': dto['path'], 'sha256': digest(piece), 'size': len(block)})
    manifest = {'version': 1, 'project': project, 'sha256': digest(archive), 'parts': parts}
    save(Path(directory) / 'transfer.json', manifest)
    return manifest


def receive(manifest, output):
    data = json.loads(Path(manifest).read_text())
    if data.get('version') != 1 or not data.get('parts'):
        raise ValueError('Unsupported/empty transfer manifest')
    if Path(output).exists():
        raise ValueError('Receive requires a new directory')
    with tempfile.TemporaryDirectory(prefix='bb-transfer-') as tmp:
        archive = Path(tmp) / 'payload.tar.gz'
        with archive.open('wb') as target:
            for item in data['parts']:
                piece = Path(tmp) / 'chunk'
                bb('project', 'attachment', 'download', data['project'], item['path'],
                   '--client-file', str(piece))
                if piece.stat().st_size != item['size'] or digest(piece) != item['sha256']:
                    raise ValueError('Attachment checksum mismatch')
                with piece.open('rb') as source:
                    shutil.copyfileobj(source, target)
        if digest(archive) != data['sha256']:
            raise ValueError('Archive checksum mismatch')
        extract(archive, output)
    return {'directory': str(Path(output).resolve()), 'sha256': data['sha256']}


def publish(directory, output, project):
    root = Path(directory).resolve()
    out = Path(output).resolve()
    if out.is_relative_to(root):
        raise ValueError('Transfer output must be outside the evidence directory')
    out.mkdir(parents=True, exist_ok=False)
    names = [p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file() or p.is_symlink()]
    pack(root, out / 'payload.tar.gz', names)
    return upload(out / 'payload.tar.gz', out, project)


def validate_remote(remote):
    # A controller-local path cannot be fetched on a different machine.
    if re.fullmatch(r'[\w.-]+@[\w.-]+:[^\s]+', remote):
        return
    url = urlsplit(remote)
    if (url.scheme not in ('https', 'ssh') or not url.hostname or
        url.password or (url.scheme == 'https' and url.username) or url.query or url.fragment):
        raise ValueError('Use a network Git remote without embedded credentials')


def validate_branch(branch, url, remote, main_reason):
    if branch not in ('main', 'master', 'origin/main', 'origin/master'):
        return
    path = url.split(':', 1)[1] if url.startswith('git@github.com:') else urlsplit(url).path
    host = 'github.com' if url.startswith('git@github.com:') else urlsplit(url).hostname
    owner = path.lstrip('/').split('/')[0]
    if not (branch == 'main' and remote == 'origin' and host == 'github.com' and
            owner.lower() == 'smsunarto' and main_reason and main_reason.strip()):
        raise ValueError('Use a feature branch. origin/main requires a necessary --main-reason and an smsunarto GitHub repository.')


def repository_id(url):
    validate_remote(url)
    if '://' not in url:
        host, path = url.split('@', 1)[1].split(':', 1)
    else:
        parsed = urlsplit(url)
        host, path = parsed.hostname, parsed.path
    return host.lower(), path.strip('/').removesuffix('.git')


def push_branch(repo, branch, remote, url):
    config = json.loads(command('but', 'config', 'push-remote', '--json', cwd=repo))
    if config['push_remote'] != remote:
        raise ValueError('GitButler push remote differs from the handoff remote. Align it before publishing.')
    destinations = command('git', '-C', str(repo), 'remote', 'get-url', '--push', '--all', remote).splitlines()
    if len(destinations) != 1 or repository_id(destinations[0]) != repository_id(url):
        raise ValueError('Git push URL differs from the assigned repository')
    state = json.loads(command('but', 'status', '--json', cwd=repo))
    for stack in state['stacks']:
        names = [b['name'] for b in stack['branches']]
        if branch in names:
            # GitButler pushes the selected branch and its ancestors (listed below it).
            for ancestor in names[names.index(branch) + 1:]:
                local = command('git', '-C', str(repo), 'rev-parse', f'refs/heads/{ancestor}').strip()
                published = command('git', 'ls-remote', '--heads', '--', url, f'refs/heads/{ancestor}').strip()
                if published != f'{local}\trefs/heads/{ancestor}':
                    raise ValueError('Push would publish an ancestor branch. Use an independently publishable task branch.')
            break
    else:
        raise ValueError('Task branch is not applied in this GitButler workspace')
    command('but', 'push', branch, '--dry-run', cwd=repo)
    command('but', 'push', branch, cwd=repo)


def git_source(repo, branch, base, remote, main_reason=None):
    command('git', 'check-ref-format', '--branch', branch)
    head = command('git', '-C', str(repo), 'rev-parse', '--verify', '--end-of-options',
                   f'refs/heads/{branch}^{{commit}}').strip()
    target = command('git', '-C', str(repo), 'rev-parse', '--verify', '--end-of-options',
                     f'{base}^{{commit}}').strip()
    comparison = command('git', '-C', str(repo), 'merge-base', head, target).strip()
    url = command('git', '-C', str(repo), 'remote', 'get-url', '--', remote).strip()
    validate_remote(url)
    validate_branch(branch, url, remote, main_reason)
    push_branch(repo, branch, remote, url)
    published = command('git', 'ls-remote', '--heads', '--', url, f'refs/heads/{branch}')
    if published.strip() != f'{head}\trefs/heads/{branch}':
        raise ValueError('Task branch is not published at the selected commit. Commit/push with GitButler first.')
    return {'version': 1, 'remote': url, 'branch': branch, 'head': head, 'base': comparison,
            'initial_head': head, 'main_reason': main_reason}


def checkout_source(source, output):
    data = json.loads(Path(source).read_text())
    if data.get('version') != 1 or not all(re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', data[k])
                                         for k in ('head', 'base')):
        raise ValueError('Expected full Git commit IDs in the source manifest')
    validate_remote(data['remote'])
    destination = Path(output).resolve()
    if destination.exists():
        raise ValueError('Checkout requires a new directory; existing work is never reset')
    command('git', 'check-ref-format', '--branch', data['branch'])
    destination.parent.mkdir(parents=True, exist_ok=True)
    command('git', 'clone', '--no-local', '--branch', data['branch'], '--', data['remote'], str(destination))
    actual = command('git', '-C', str(destination), 'rev-parse', 'HEAD').strip()
    if actual != data['head']:
        raise ValueError('Checkout commit does not match the requested test commit')
    command('git', '-C', str(destination), 'merge-base', '--is-ancestor', data['base'], actual)
    history = command('git', '-C', str(destination), 'log', '--oneline', '-30', f"{data['base']}..{actual}")
    diff = command('git', '-C', str(destination), 'diff', '--stat', data['base'], actual)
    return {'directory': str(destination), 'head': actual, 'base': data['base'],
            'recent_commits': history, 'diff_stat': diff}


def revise(thread_id, task):
    context = bb('status')
    thread = bb('thread', 'show', thread_id)['thread']
    if thread['parentThreadId'] != context['thread']['id'] or thread['providerId'] != 'codex':
        raise ValueError('Revision must reuse this parent\'s existing Codex child')
    if thread['status'] not in ('idle', 'failed'):
        raise ValueError('Let the testing turn finish before starting the Astra high revision turn')
    message = ('Continue in your existing checkout and failure context. You now own fixes and retests '
               'on the assigned feature branch. Commit and publish revisions with publish-fix, '
               'then return the final tested commit and evidence.\n\n' + Path(task).read_text())
    return bb('thread', 'tell', thread_id, message, '--mode', 'auto', '--model', MODEL,
              '--reasoning-level', 'high')


def publish_fix(repo, source):
    data = json.loads(Path(source).read_text())
    url = command('git', '-C', str(repo), 'remote', 'get-url', 'origin').strip()
    if url != data['remote']:
        raise ValueError('Fix repository does not match the assigned remote')
    validate_branch(data['branch'], url, 'origin', data.get('main_reason'))
    head = command('git', '-C', str(repo), 'rev-parse', '--verify', '--end-of-options',
                   f"refs/heads/{data['branch']}^{{commit}}").strip()
    command('git', '-C', str(repo), 'diff', '--quiet', head, '--')
    if command('git', '-C', str(repo), 'ls-files', '--others', '--exclude-standard').strip():
        raise ValueError('Commit new source files and keep generated evidence outside the checkout before publishing')
    command('git', '-C', str(repo), 'merge-base', '--is-ancestor', data['head'], head)
    published = command('git', 'ls-remote', '--heads', '--', url, f"refs/heads/{data['branch']}").strip()
    if published != f"{data['head']}\trefs/heads/{data['branch']}":
        raise ValueError('Remote branch changed ownership/tip. Coordinate with the parent before pushing.')
    push_branch(repo, data['branch'], 'origin', url)
    published = command('git', 'ls-remote', '--heads', '--', url, f"refs/heads/{data['branch']}").strip()
    if published != f"{head}\trefs/heads/{data['branch']}":
        raise ValueError('Published revision does not match the local commit')
    data['head'] = head
    save(source, data)
    return data


def sync_result(repo, source, apply=False):
    data = json.loads(Path(source).read_text())
    url = command('git', '-C', str(repo), 'remote', 'get-url', 'origin').strip()
    if url != data['remote']:
        raise ValueError('Result repository does not match the assigned remote')
    ref = f"refs/heads/{data['branch']}^{{commit}}"
    local = command('git', '-C', str(repo), 'rev-parse', '--verify', '--end-of-options', ref).strip()
    if local == data['head']:
        return {'head': local, 'updated': False}
    if local != data['initial_head']:
        raise ValueError('Local task branch changed during remote ownership. Coordinate before integrating.')
    command('but', 'pull', '--check', cwd=repo)
    tracked = command('git', '-C', str(repo), 'rev-parse', '--verify', '--end-of-options',
                      f"refs/remotes/origin/{data['branch']}^{{commit}}").strip()
    if tracked != data['head']:
        raise ValueError('Remote tip no longer matches the tested result')
    command('git', '-C', str(repo), 'merge-base', '--is-ancestor', data['initial_head'], data['head'])
    changed = set(command('git', '-C', str(repo), 'diff', '--name-only', '-z',
                          data['initial_head'], data['head']).strip('\0').split('\0'))
    state = json.loads(command('but', 'status', '--json', cwd=repo))
    if any(c['filePath'] in changed for c in state['uncommittedChanges']):
        raise ValueError('Uncommitted local changes overlap the remote result')
    for stack in state['stacks']:
        if any(b['name'] == data['branch'] for b in stack['branches']) and stack['assignedChanges']:
            raise ValueError('The task branch has assigned uncommitted changes')
    preview = command('but', 'branch', 'update', data['branch'], '--strategy', 'pull-rebase', '--dry-run', cwd=repo)
    if not apply:
        return {'head': data['head'], 'updated': False, 'preview': preview,
                'next': 'Inspect the preview. If it is clean and scoped, repeat with --apply.'}
    command('but', 'branch', 'update', data['branch'], '--strategy', 'pull-rebase', cwd=repo)
    actual = command('git', '-C', str(repo), 'rev-parse', '--verify', '--end-of-options', ref).strip()
    if actual != data['head']:
        raise ValueError('Integrated branch differs from the tested commit. Inspect before continuing.')
    return {'head': actual, 'updated': True}


def launch(args):
    if not os.environ.get('BB_THREAD_ID'):
        raise ValueError('Launch from a BB parent thread')
    machines = bb('machine', 'list')
    target = next((m for m in machines if m['name'] == args.machine), None)
    if not target or target['status'] != 'connected':
        raise ValueError('Machine unavailable. Resolve connection/authentication before choosing another.')
    if args.machine == 'Dev Mac' and not args.mac_reason:
        raise ValueError('Dev Mac requires --mac-reason mac-required|cardinal-overloaded')
    models = bb('provider', 'models', 'codex', '--machine', target['id'])
    if not any(m['id'] == MODEL and any(e['reasoningEffort'] == 'low'
               for e in m['supportedReasoningEfforts']) for m in models):
        raise ValueError('Codex Astra low unavailable. Resolve provider/authentication on this machine.')
    context = bb('status')
    project = context['project']['id']
    parent = context['thread']['id']
    projects = bb('project', 'list', '--include-personal')
    personal = next((p['id'] for p in projects if p.get('kind') == 'personal'), None)
    if not personal:
        raise ValueError('No personal project for remote bootstrap')
    root = Path(command('git', '-C', str(Path(args.repo).resolve()), 'rev-parse', '--show-toplevel').strip())
    source = git_source(root, args.branch, args.base, args.remote, args.main_reason)
    out = Path(args.out).resolve()
    if out.is_relative_to(root):
        raise ValueError('Use thread storage outside the source tree for launch output')
    out.mkdir(parents=True, exist_ok=False)
    save(out / 'source.json', source)
    helper = Path(__file__).resolve()
    dto = bb('project', 'attachment', 'upload', project, '--client-file', str(helper),
             '--mime-type', 'text/plain')
    run = 'remote-test-' + uuid.uuid4().hex[:12]
    contract = (helper.parent.parent / 'references' / 'worker.md').read_text()
    prompt = (f'Remote /subthread assignment. Run {run}. Parent {parent}. Project {project}.\n'
              f'Machine: {args.machine}. Selection reason: {args.mac_reason or "preferred Cardinal"}.\n'
              'First download the helper with the command below and verify its SHA256 before running it.\n'
              f'bb project attachment download {project} {dto["path"]} --client-file /tmp/{run}.py\n'
              f'Helper SHA256: {digest(helper)}\n'
              f'Write this Git source JSON to a local file: {json.dumps(source)}\n\n'
              + contract + '\n\nTask:\n' + Path(args.task).read_text())
    save(out / 'handoff.json', {'run': run, 'machine': target, 'parent': parent, 'source': source['head']})
    thread = bb('thread', 'spawn', '--parent-self', '--project', personal, '--machine', target['id'],
                '--new-environment', 'personal', '--provider', 'codex', '--model', MODEL,
                '--reasoning-level', 'low', '--title', f'Test remotely: {root.name}', '--prompt', prompt)
    save(out / 'thread.json', thread)
    return {'run': run, 'thread': thread, 'source': str(out / 'source.json')}


def capacity():
    cpus = os.cpu_count() or 1
    if sys.platform == 'linux':
        mem = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        available = int(mem['MemAvailable'].strip().split()[0]) * 1024
        total = int(mem['MemTotal'].strip().split()[0]) * 1024
    elif sys.platform == 'darwin':
        total = int(command('sysctl', '-n', 'hw.memsize'))
        vm = command('vm_stat')
        page = int(re.search(r'page size of (\d+)', vm)[1])
        pages = dict(re.findall(r'^(Pages [\w ]+):\s+(\d+)\.', vm, re.M))
        available = sum(int(pages.get(k, 0)) for k in ('Pages free', 'Pages inactive', 'Pages speculative')) * page
    else:
        raise ValueError('Capacity measurement supports Linux and macOS')
    return {'cpus': cpus, 'load1': os.getloadavg()[0], 'load5': os.getloadavg()[1],
            'memory_gib': total / 2**30, 'available_gib': available / 2**30,
            'disk_free_gib': shutil.disk_usage(Path.home()).free / 2**30}


def admission(sample, claims, cpus, memory, resources):
    if any('machine-setup' in c['resources'] or 'machine-setup' in resources or
           set(c['resources']) & set(resources) for c in claims):
        return 'resource-conflict'
    if sum(c['cpus'] for c in claims) + cpus > max(1, sample['cpus'] * .8):
        return 'cpu-reservations'
    if sample['load1'] + cpus > max(1, sample['cpus'] * .8):
        return 'cpu-load'
    if (memory > sample['available_gib'] - sample['memory_gib'] * .2 or
        sum(c['memory_gib'] for c in claims) + memory > sample['memory_gib'] * .8):
        return 'memory-capacity'
    return None


def reservations(args):
    root = Path.home() / '.cache' / 'bb-remote-tests'
    root.mkdir(parents=True, exist_ok=True)
    with (root / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = root / 'reservations.json'
        entries = json.loads(state.read_text()) if state.exists() else {}
        if args.action == 'release':
            entry = entries.get(args.run)
            if entry and entry['thread'] != os.environ.get('BB_THREAD_ID'):
                raise ValueError('Only the owning thread can release this reservation')
            entries.pop(args.run, None)
        sample = capacity()
        if args.action == 'claim':
            if not os.environ.get('BB_THREAD_ID'):
                raise ValueError('Claim requires a BB worker thread')
            if args.run in entries:
                raise ValueError('Run already reserved. Release before changing its budget.')
            reason = admission(sample, entries.values(), args.cpus, args.memory_gib, args.resource)
            if reason:
                return {'admitted': False, 'reason': reason, 'capacity': sample, 'reservations': entries}
            entries[args.run] = {'thread': os.environ['BB_THREAD_ID'], 'cpus': args.cpus,
                                 'memory_gib': args.memory_gib, 'resources': args.resource,
                                 'created': time.time()}
        if args.action != 'capacity':
            temporary = root / 'reservations.tmp'
            save(temporary, entries)
            temporary.replace(state)
        return {'admitted': True, 'capacity': sample, 'reservations': entries}


def positive(value):
    number = float(value)
    if not 0 < number < float('inf'):
        raise argparse.ArgumentTypeError('Must be finite and positive')
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('inventory')
    p = sub.add_parser('launch')
    for key in ('repo', 'task', 'out'):
        p.add_argument('--' + key, required=True)
    p.add_argument('--machine', choices=['codex@cardinal', 'Dev Mac'], default='codex@cardinal')
    p.add_argument('--mac-reason', choices=['mac-required', 'cardinal-overloaded'])
    p.add_argument('--branch', required=True, help='Task branch containing committed work; pushed by the helper')
    p.add_argument('--base', default='origin/main', help='Comparison target; resolves to its merge base')
    p.set_defaults(remote='origin')
    p.add_argument('--main-reason', help='Why origin/main is unavoidable; only for smsunarto GitHub repos')
    p = sub.add_parser('checkout')
    p.add_argument('--source', required=True, help='Pinned Git source JSON from the parent')
    p.add_argument('--out', required=True, help='New isolated checkout directory')
    p = sub.add_parser('revise')
    p.add_argument('--thread', required=True)
    p.add_argument('--task', required=True)
    p = sub.add_parser('publish-fix')
    p.add_argument('--repo', required=True)
    p.add_argument('--source', required=True)
    p = sub.add_parser('sync-result')
    p.add_argument('--repo', required=True)
    p.add_argument('--source', required=True, help='Updated source manifest returned by the worker')
    p.add_argument('--apply', action='store_true', help='Apply after reviewing the default dry-run preview')
    p = sub.add_parser('receive')
    p.add_argument('--manifest', required=True)
    p.add_argument('--out', required=True)
    p = sub.add_parser('publish')
    for key in ('directory', 'out', 'project'):
        p.add_argument('--' + key, required=True)
    sub.add_parser('capacity')
    p = sub.add_parser('claim')
    p.add_argument('--run', required=True)
    p.add_argument('--cpus', type=positive, required=True)
    p.add_argument('--memory-gib', type=positive, required=True)
    p.add_argument('--resource', action='append', default=[])
    p = sub.add_parser('release')
    p.add_argument('--run', required=True)
    args = parser.parse_args()
    if args.action == 'inventory':
        threads = bb('thread', 'list', '--include-hidden')
        active = [t for t in threads if not t.get('archivedAt') and
                  (t['status'] not in ('idle', 'failed') or any(t.get('activity', {}).values()))]
        result = {'machines': bb('machine', 'list'), 'active_threads': [
            {k: t.get(k) for k in ('id', 'title', 'status', 'environmentHostId', 'activity')}
            for t in active]}
    elif args.action == 'launch':
        result = launch(args)
    elif args.action == 'checkout':
        result = checkout_source(args.source, args.out)
    elif args.action == 'revise':
        result = revise(args.thread, args.task)
    elif args.action == 'publish-fix':
        result = publish_fix(args.repo, args.source)
    elif args.action == 'sync-result':
        result = sync_result(args.repo, args.source, args.apply)
    elif args.action == 'receive':
        result = receive(args.manifest, args.out)
    elif args.action == 'publish':
        result = publish(args.directory, args.out, args.project)
    else:
        result = reservations(args)
    print(json.dumps(result, indent=2))
    return 2 if result.get('admitted') is False else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.CalledProcessError, KeyError) as error:
        sys.exit(f'remote-test: {error}')
