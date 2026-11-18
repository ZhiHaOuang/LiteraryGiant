#!/usr/bin/env python3
"""Seed published lib/runtime files without overwriting plugin source or later local builds."""
import base64
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile

root = Path(__file__).resolve().parent.parent
lock = json.loads((root / 'dsh-plugins/sources.lock.json').read_text())
cache = root / '.dsh-dev/plugin-cache'
cache.mkdir(parents=True, exist_ok=True)
for item in lock['sources']:
    if 'dist' not in item:
        continue
    package = root / item['path']
    name = package.name
    version = item['npmVersion']
    if json.loads((package / 'package.json').read_text())['version'] != version:
        raise RuntimeError(name + ': source version differs from locked release')
    marker = cache / (name + '-' + version + '.seeded.json')
    if marker.exists():
        recorded = json.loads(marker.read_text())
        if recorded['integrity'] != item['dist']['integrity']:
            raise RuntimeError(name + ': seed marker differs from locked release')
        missing = [path for path in recorded['files'] if not (package / path).is_file()]
        if missing:
            raise RuntimeError(name + ': output files missing; rebuild plugin: ' + ', '.join(missing[:3]))
        # A later source build belongs to the developer; never replace it with release bytes.
        print(name + ': already seeded; preserving local build')
        continue
    archive = cache / (name + '-' + version + '.tgz')
    if not archive.exists():
        subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error', '--max-time', '180',
                        item['dist']['tarball'], '--output', str(archive)], check=True)
    actual = 'sha512-' + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
    if actual != item['dist']['integrity']:
        raise RuntimeError(name + ': archive integrity mismatch')
    files = []
    with tarfile.open(archive) as tar:
        for member in tar:
            parts = PurePosixPath(member.name).parts
            if len(parts) < 3 or parts[0] != 'package' or parts[1] not in ('lib', 'runtime'):
                continue
            relative = PurePosixPath(*parts[1:])
            if '..' in relative.parts or not (member.isfile() or member.isdir()):
                raise RuntimeError(name + ': unexpected archive entry ' + member.name)
            if member.isdir():
                continue
            path = package / str(relative)
            if not path.resolve().is_relative_to(package.resolve()):
                raise RuntimeError(name + ': archive target escapes package')
            body = tar.extractfile(member).read()
            if path.exists() and path.read_bytes() != body:
                raise RuntimeError(name + ': existing output differs; refusing to overwrite ' + str(relative))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
            path.chmod(0o755 if member.mode & 0o111 else 0o644)
            files.append(str(relative))
    if not files:
        raise RuntimeError(name + ': no published output found')
    marker.write_text(json.dumps({'integrity': actual, 'files': files}, indent=2) + '\n')
    print(name + ': verified and seeded ' + str(len(files)) + ' published output files')
