"""Replay the bounded team through the project's real CLI; no provider requests."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--lab', type=Path, required=True, help='Prepared LitIsLand lab containing agent-teams, snapshot.json and main-home')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
lab = args.lab.resolve()
run = Path(tempfile.mkdtemp(prefix='preflight-smoke-', dir=lab))
modules = run/'node_modules'
modules.mkdir()
host = repo/'dsh'
for pattern in ['vendor/*/package.json', 'packages/*/*/package.json', 'apps/*/package.json', 'native/system/packages/*/package.json']:
    for manifest in host.glob(pattern):
        name = json.loads(manifest.read_text()).get('name')
        if not name: continue
        target = modules/name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(manifest.parent, target_is_directory=True)
teams = run/'agent-teams'
shutil.copytree(lab/'agent-teams', teams, ignore=shutil.ignore_patterns('node_modules', '.git'))
(teams/'node_modules').symlink_to(modules, target_is_directory=True)
profile = run/'home/profiles/literary'
profile.mkdir(parents=True)
(profile/'node_modules').symlink_to(modules, target_is_directory=True)
source_profile = lab/'main-home/profiles/literary'
for name in ['package.json', 'cordis.yml']:
    shutil.copy2(source_profile/name, profile/name)
config = (source_profile/'cordis.patch.yml').read_text()
config = config.replace(str(lab/'agent-teams'), str(teams))
config = config.replace(str(lab/'lg-literary-team'), str(repo/'dsh-plugins/lg-literary-team'))
for name in ['probe.mjs', 'driver.mjs']:
    config = config.replace(str(lab/name), str(repo/'experiments/literary-team-v1'/name))
config = config.replace('    - id: request-budget',
    '    - id: lg-agent-preflight\n      name: '+str(repo/'dsh-plugins/lg-agent-preflight/index.js')+'\n      config:\n        toolNames: [lg_read_chapter, lg_read_analysis]\n    - id: request-budget')
(profile/'cordis.patch.yml').write_text(config)
for parent in [repo/'experiments/literary-team-v1', repo/'dsh-plugins/lg-literary-team', repo/'dsh-plugins/lg-agent-preflight']:
    link = parent/'node_modules'
    if not link.exists(): link.symlink_to(modules, target_is_directory=True)
for name in ['user-home', 'tmp', 'workspace']:
    (run/name).mkdir()
node = repo/'.dsh-dev/node/bin/node'
env = {'PATH': str(node.parent)+':/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(run/'user-home'), 'TMPDIR': str(run/'tmp'),
       'LANG': 'en_US.UTF-8', 'DSH_HOME': str(run/'home'), 'DSH_PERMISSION_MODE': 'read-only', 'DSH_TELEMETRY_DISABLED': '1',
       'LG_VALIDATION_API_KEY': 'offline-unused', 'LG_LAB_DRY': '1', 'LG_LAB_MODE': 'team', 'LG_LAB_RUN': str(run),
       'LG_LAB_LEDGER': str(lab/'paid-ledger'), 'LG_LAB_SNAPSHOT': str(lab/'snapshot.json')}
with (run/'stdout.log').open('w') as out, (run/'stderr.log').open('w') as err:
    process = subprocess.Popen([str(node), str(host/'apps/cli/lib/bin.js'), '--profile', 'literary', '--json', 'keyless analysis replay'],
                               cwd=run/'workspace', env=env, stdout=out, stderr=err, start_new_session=True)
    timed_out = False
    try: code = process.wait(timeout=60)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(process.pid, signal.SIGTERM)
        try: code = process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            code = process.wait()
result = {'exitCode': code, 'timedOut': timed_out, 'run': str(run), 'modelRequests': 0}
(run/'process.json').write_text(json.dumps(result, indent=2))
if code == 0 and not timed_out:
    result['team'] = json.loads((run/'result.json').read_text())
print(json.dumps(result))
raise SystemExit(0 if code == 0 and not timed_out else 1)
