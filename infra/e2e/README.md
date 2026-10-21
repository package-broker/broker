# Hetzner candidate lifecycle

Release layer H creates one server per run, a 10 GB ext4 data volume, one primary
IPv4 and an SSH-only firewall. The default server is CX23 (`amd64`) in
`fsn1`; the orchestrator can override type, architecture and location together.
Every created resource has `pb_e2e=true`, `run_id` and `expires_at` (epoch seconds,
at most six hours ahead). IPv6 is disabled. There is no fixed spending ceiling;
the expiry and E2E-10 janitor remain required.

A credential-free Cloudflare quick tunnel assigns a random public
`https://<name>.trycloudflare.com` origin. TLS terminates at the Cloudflare edge
and acceptance uses the controller's public CA trust store. No domain, DNS
record or certificate input is needed.

The `hetzner.hcloud` collection is pinned to `6.12.0` in `requirements.yml`.
There are no external roles or other collections. Provision the protected
runner with Ansible, ansible-lint, the collection's Python requirements, Git,
OpenSSH, OpenSSL and Python 3. The runner does not need Docker. Install the
prescribed collection in a connected provisioning environment:

```sh
ansible-galaxy collection install -r infra/e2e/requirements.yml
```

## Operator inputs

Copy `inventory.example.yml` to ignored `inventory.local.yml`. Replace every
placeholder. Export a Read & Write API token of the dedicated Hetzner Cloud
project as `HCLOUD_TOKEN` in the runner's environment. Write the private half of
the project's registered SSH key to a protected local file and set
`e2e_ssh_private_key_file` to its absolute path. The project must
already have the public SSH key named `ci`. This lifecycle neither creates a
per-run key nor deletes `ci`. Do not put secrets in command arguments or the
inventory. Supply an absolute path to the production-format broker master key.
Secret copies disable Ansible logging and diffs.

Select a numeric Debian cloud image ID and exact `docker.io` apt version for
that OS. Pin `e2e_cloudflared_version` to an approved release and
`e2e_cloudflared_sha256` to the SHA-256 of its Linux binary for `e2e_arch`.
The target downloads that version from the Cloudflare GitHub release and
verifies the checksum; automatic updates are disabled. Resolve these pins in
the orchestrator's connected environment before the live run.

Set `e2e_runner_cidrs` to the runner's public source addresses, each with `/32`
for IPv4 or `/128` for IPv6. The firewall is attached at server creation and
allows inbound TCP 22 only from those addresses. It has no HTTP or HTTPS ingress
rule. Outbound traffic is allowed: the tunnel uses TCP/UDP 7844 and HTTPS 443;
provisioning also needs DNS, apt, source-build dependencies and image downloads.
The runner needs outbound HTTPS for Hetzner and the public tunnel origin.

## Exact candidate and image source

Set `e2e_candidate_commit` to the full 40-character commit SHA. With the default
`e2e_image_source: target_build`, that commit must exist in this working copy's
Git object database. `git archive` exports only that commit, excluding local
changes and untracked files. Ansible transfers the source archive, builds the
repository Dockerfile on the new server, and captures `docker build --iidfile`.
The target build needs registry/package access. This authorizes no public
registry traffic in later test layers; those belong to layer X.

Target builds explicitly enable BuildKit with `DOCKER_BUILDKIT=1`. Before the
candidate build, a network-free `FROM scratch` heredoc build checks that the
pinned Docker configuration supports the Dockerfile's heredoc syntax. Missing
BuildKit, missing required builder tooling or an older bundled frontend fails
with NOT RUN before building the candidate. In particular, selecting Debian
Bookworm's `docker.io` 20.10 package alone does not establish compatibility.
Supply a compatible pinned Docker configuration or select the GHCR path; the
playbook does not install additional builder dependencies or fall back to the
legacy builder. The capability check and candidate build use the same builder
environment. GHCR mode needs no builder.

The broker runs using the resulting `sha256:` **local image config digest**,
with `--pull=never`. This is distinguished from a registry manifest digest in
outputs. No candidate image is built on the runner or transported with
`docker save`/`load`. The image's architecture, Linux OS, user `1000:1000` and
`org.opencontainers.image.revision` label are checked before startup.

After T835 publishes to GHCR, set `e2e_image_source: ghcr` and
`e2e_registry_image: ghcr.io/OWNER/IMAGE@sha256:MANIFEST_DIGEST`. This selects the
same lifecycle with an exact digest pull on the target. The published image
must carry the matching OCI revision label. Output records both the manifest
digest and local config ID. Private GHCR pulls require separately provisioned
target Docker credentials; do not place them in inventory or logs.

## Origin discovery and later layers

The broker starts with a temporary loopback `PB_PUBLIC_URL`, published only at
`127.0.0.1:8787`, and passes a local readiness check. Then systemd starts the
pinned `cloudflared tunnel --url http://127.0.0.1:8787` process with no account,
credentials or automatic process restart. Ansible reads only the current
systemd invocation's journal, with a one-minute bounded poll. It retries startup
once; failure to discover a URL reports NOT RUN and fails the leg.

The discovered origin becomes the `e2e_public_url` fact on the candidate and
controller. Ansible rewrites `PB_PUBLIC_URL`, restarts the broker, and only then
runs public acceptance. After reboot, it reads the new invocation's URL,
reconfigures the broker again, and repeats acceptance. The URL can change.
Do not restart the tunnel independently: any new process needs discovery and
broker reconfiguration before tests resume.

The broker retains its existing trust defaults and derives its canonical origin
from `PB_PUBLIC_URL`. The only published broker socket is host loopback, which
the local tunnel uses. This checkout exposes no configurable proxy-address
allowlist; no invented trust environment variable or broader trace-header trust
is enabled here. Any additional application-level forwarded-header allowlist
requires a separate product change outside this packet.

`runs/<run-id>/outputs.json` contains the current `PB_PUBLIC_URL`, candidate SHA,
image digest, digest kind, image reference, local image ID and phase. Every later
layer must read this file or inherit the wrapper's `PB_PUBLIC_URL`; never cache
an earlier origin or use a fixed Node hostname. To run an existing harness while
the server is alive, pass its command and arguments to the wrapper:

```sh
infra/e2e/lifecycle.sh infra/e2e/inventory.local.yml path/to/harness arg1
```

The command runs after reboot acceptance and before cleanup. It receives
`PB_PUBLIC_URL` and the absolute `PB_E2E_OUTPUTS` path. A failure propagates after
cleanup. Harnesses should keep fixtures well below the quick tunnel's 100 MB
body limit and concurrency low. Quick tunnels have no SLA; an unavailable origin
is a failed or NOT RUN leg, never a pass or silent skip.

## Local gates

From the repository root with the pinned collection already provisioned:

```sh
ansible-playbook --syntax-check infra/e2e/site.yml
ansible-playbook --syntax-check infra/e2e/destroy.yml
ansible-lint infra/e2e
bash -n infra/e2e/lifecycle.sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s infra/e2e/tests -v
pnpm check
pnpm check:treeshake
pnpm check:pack
pnpm bundle
pnpm smoke:cloudflare
SMOKE_OFFLINE=1 pnpm smoke:node
```

Missing tools, credentials or inputs are NOT RUN and must fail the release leg.
Check mode is refused because it cannot prove create, reboot or deletion.

The infrastructure regression tests use the runner's existing Ansible,
PyYAML and Jinja2. They validate the firewall ID shape and run the real image
preparation tasks against a fake Docker executable, covering BuildKit selection,
unsupported builders and GHCR bypass. They make no Docker daemon or cloud calls.
Set `ANSIBLE_PLAYBOOK` to an alternate existing executable when needed. These
tests do not replace validation against the pinned Hetzner collection or a live
target build.

## Live acceptance and recovery

Without an optional harness, the wrapper runs the infrastructure acceptance:

```sh
infra/e2e/lifecycle.sh infra/e2e/inventory.local.yml
```

It generates a fresh run ID and expiry. EXIT/INT/TERM handling invokes
`destroy.yml` twice, including after create, tunnel or harness failures, and
returns nonzero on failure. Uncatchable runner loss still needs the E2E-10
janitor. Concurrent runs use independent resources and random origins.

The non-root broker has dropped capabilities, a read-only root and the recorded
data volume at `/data`. Acceptance verifies loopback readiness, Docker health,
image identity and publicly trusted HTTPS `/health/ready` without redirects or
a custom CA. It writes a marker as UID 1000, reboots, repeats URL discovery and
acceptance, and verifies the same volume, marker and SQLite ownership.

`resources.json` is the atomically replaced, non-secret resource journal. IDs
and timestamps are saved after each create, before the next cloud action. It
also records candidate/image identity, both public URLs and discovery times,
successful acceptance time and teardown history. Preserve it and `outputs.json`
as release evidence; report actual IDs, URLs and timings. A recorded URL can
outlive its tunnel and is not proof of a running server. Preserve the input
inventory as protected operator configuration. The temporary committed source
archive and isolated `known_hosts` file are removed after successful cleanup.
The owner private key stays at its operator-managed path and is never copied
into the run directory. SSH accepts the new server's key on first connection
and refuses subsequent changes.

For a partial run, only its journal, run ID and project token are needed:

```sh
ansible-playbook infra/e2e/destroy.yml -e e2e_run_id=RECORDED_RUN_ID
ansible-playbook infra/e2e/destroy.yml -e e2e_run_id=RECORDED_RUN_ID
```

Destroy verifies recorded numeric IDs and ownership labels, deletes server,
volume, primary IP and firewall in dependency order, and confirms each exact ID
returns 404. It retains support for old journals' labelled per-run SSH keys;
the shared `ci` key is never journaled as a deletable resource. Already-absent
resources succeed. Other API errors, foreign labels and malformed/missing
journals remain failures, and each remaining resource is attempted after an
individual failure. Both destroys retain IDs and append evidence.

Runner loss between provider creation and journal persistence remains a
cross-system failure window. All creates retain the expiry labels consumed by
the E2E-10 janitor; it must reconcile expired servers and their volume, IP and
firewall resources. Never substitute prefix deletion. Live acceptance must also
inspect the dedicated project for surviving run servers beyond journaled IDs.
Live acceptance stays NOT RUN until the orchestrator supplies the Hetzner token
and runs create, trusted HTTPS, reboot, destroy twice and final inspection.
