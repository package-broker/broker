#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."

if [[ $# -lt 1 || ! -f "$1" ]]; then
  echo 'Usage: infra/e2e/lifecycle.sh infra/e2e/inventory.local.yml [harness-command [args...]]' >&2
  exit 2
fi
for binary in ansible-playbook git ssh openssl python3; do
  if ! command -v "$binary" >/dev/null; then
    echo "NOT RUN: required binary $binary is missing" >&2
    exit 1
  fi
done
if [[ -z ${HCLOUD_TOKEN:-} ]]; then
  echo 'NOT RUN: HCLOUD_TOKEN and operator inventory inputs are required' >&2
  exit 1
fi

inventory="$1"
shift

run_id="$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 6)"
expires_at="$(( $(date +%s) + 21600 ))"
journal="infra/e2e/runs/$run_id/resources.json"
printf 'Run: %s\nJournal: %s\n' "$run_id" "$journal"
cleanup() {
  status=$?
  trap - EXIT
  trap '' INT TERM
  if [[ -f "$journal" ]]; then
    ansible-playbook infra/e2e/destroy.yml -e "e2e_run_id=$run_id" || status=1
    ansible-playbook infra/e2e/destroy.yml -e "e2e_run_id=$run_id" || status=1
  else
    echo 'NOT RUN: no resource journal exists; no cloud create should have started' >&2
    status=1
  fi
  exit "$status"
}
trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup EXIT
ansible-playbook -i "$inventory" infra/e2e/site.yml \
  -e "e2e_run_id=$run_id" -e "e2e_expires_at=$expires_at"

outputs="infra/e2e/runs/$run_id/outputs.json"
public_url="$(python3 - "$outputs" <<'PYTHON'
import json, re, sys
with open(sys.argv[1]) as source:
    outputs = json.load(source)
origin = outputs['PB_PUBLIC_URL']
if not re.fullmatch(r'https://[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com', origin):
    sys.exit('NOT RUN: invalid or absent tunnel origin')
print(origin)
PYTHON
)"
printf 'PB_PUBLIC_URL=%s\nOutputs: %s\n' "$public_url" "$outputs"
if [[ $# -gt 0 ]]; then
  env -u HCLOUD_TOKEN PB_PUBLIC_URL="$public_url" PB_E2E_OUTPUTS="$PWD/$outputs" "$@"
fi
