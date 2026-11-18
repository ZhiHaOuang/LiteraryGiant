#!/usr/bin/env python3
"""Run the vendored DSH with Node >=24.9 and its pinned pnpm."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
local_node = root / '.dsh-dev/node/bin/node'
node = os.environ.get('LG_NODE') or (str(local_node) if local_node.is_file() else shutil.which('node'))
if not node:
    sys.exit('Node >=24.9 is required. Set LG_NODE to its executable or install Node on PATH.')
node = str(Path(node).expanduser().resolve())
version = subprocess.check_output([node, '-p', 'process.versions.node'], text=True).strip()
if tuple(map(int, version.split('.')[:2])) < (24, 9):
    sys.exit('Node >=24.9 is required; found ' + version)
env = {**os.environ, 'PATH': str(Path(node).parent) + os.pathsep + os.environ.get('PATH', '')}
if len(sys.argv) > 1 and sys.argv[1] in ('install', 'i'):
    # Vendored DSH must not install its Git hooks into LiteraryGiant's parent repository.
    env['CI'] = 'true'
pnpm = root / 'dsh/node_modules/pnpm/bin/pnpm.cjs'
if pnpm.is_file():
    command = [node, str(pnpm), *sys.argv[1:]]
else:
    npm = shutil.which('npm', path=env['PATH'])
    if not npm:
        sys.exit('npm is required to bootstrap pnpm@11.28.5.')
    command = [npm, 'exec', '--yes', '--package=pnpm@11.28.5', '--', 'pnpm', *sys.argv[1:]]
sys.exit(subprocess.call(command, cwd=root / 'dsh', env=env))
