#!/usr/bin/env python3
"""Publish immutable reports and collect each child report once per reader."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile


def identity(value):
    if not re.fullmatch(r'thr_[A-Za-z0-9]+', value):
        raise argparse.ArgumentTypeError('expected a BB thread ID')
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--thread', type=identity, required=True)
    commands = parser.add_subparsers(dest='command', required=True)
    publish = commands.add_parser('publish')
    publish.add_argument('--file', type=Path, required=True)
    collect = commands.add_parser('collect')
    collect.add_argument('--reader', type=identity, required=True)
    args = parser.parse_args(argv)
    args.directory.mkdir(parents=True, exist_ok=True)
    report = args.directory / (args.thread + '.md')
    if args.command == 'publish':
        data = args.file.read_bytes()
        if not data.strip() or data.strip() == b'<!-- slopcop:awaiting-children -->':
            parser.error('only a complete final report may be published')
        # A hard link atomically installs complete bytes without replacing a prior report.
        fd, name = tempfile.mkstemp(dir=args.directory, prefix='.publish-')
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
            try:
                os.link(name, report)
            except FileExistsError:
                if report.read_bytes() != data:
                    parser.error('a final report already exists; it cannot be replaced')
        finally:
            Path(name).unlink(missing_ok=True)
        print(json.dumps({'report': str(report), 'sha256': hashlib.sha256(data).hexdigest()}))
        return 0
    if not report.is_file():
        print(json.dumps({'status': 'pending', 'thread': args.thread}))
        return 2
    marker = args.directory / (args.reader + '--' + args.thread + '.collected')
    try:
        with marker.open('x'):
            pass
        cached = False
    except FileExistsError:
        cached = True
    # Return a durable path, never the entire report on a duplicate notification.
    print(json.dumps({'status': 'ready', 'report': str(report), 'already_collected': cached}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
