import copy
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]


def load(path):
    return yaml.safe_load((ROOT / path).read_text())


def task_named(tasks, name):
    return next(task for task in tasks if task["name"] == name)


class HardeningTests(unittest.TestCase):
    @contextmanager
    def controller(self):
        (ROOT / "runs").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT / "runs") as directory:
            work = Path(directory)
            (work / "tasks").mkdir()
            for source in (ROOT / "tasks").glob("*.yml"):
                tasks = load(f"tasks/{source.name}")
                for task in tasks:
                    self.mock_api(task)
                (work / "tasks" / source.name).write_text(yaml.safe_dump(tasks))
            (work / "library").mkdir()
            shutil.copy(ROOT / "tests/fake_api.py", work / "library/fake_api.py")
            (work / "run").mkdir(mode=0o700)
            yield work

    def mock_api(self, task):
        if "ansible.builtin.uri" in task:
            args = task.pop("ansible.builtin.uri")
            task["fake_api"] = {
                "state_file": "{{ e2e_test_api_file }}",
                "url": args["url"],
                "method": args.get("method", "GET"),
            }
        for key in ("block", "rescue", "always"):
            for child in task.get(key, []):
                self.mock_api(child)

    def run_tasks(self, work, tasks, variables=None):
        variables = {
            "ansible_python_interpreter": sys.executable,
            "e2e_run_id": "test-run-123",
            "e2e_expires_at": "1999999999",
            "e2e_run_dir": str(work / "run"),
            "e2e_inventory_file": str(work / "run/resources.json"),
            "e2e_test_api_file": str(work / "api.json"),
            **(variables or {}),
        }
        playbook = work / "test.yml"
        playbook.write_text(yaml.safe_dump([{
            "name": "Exercise lifecycle tasks with local boundary simulations",
            "hosts": "localhost", "connection": "local", "gather_facts": False,
            "vars": variables, "tasks": tasks,
        }]))
        env = {
            **os.environ,
            "PATH": str(work) + os.pathsep + os.environ["PATH"],
            "HCLOUD_TOKEN": "test-placeholder",
            "ANSIBLE_LOCAL_TEMP": str(work / "ansible-local"),
            "ANSIBLE_REMOTE_TEMP": str(work / "ansible-remote"),
            "ANSIBLE_NOCOLOR": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        return subprocess.run(
            [os.environ.get("ANSIBLE_PLAYBOOK", "ansible-playbook"),
             "-i", "localhost,", str(playbook)],
            env=env, capture_output=True, text=True, timeout=90,
        )

    def state(self, resources=None):
        return {"schema": 1, "run_id": "test-run-123", "expires_at": "1999999999",
                "resources": resources or {}, "created_at": {}}

    def test_failed_accepted_creates_journal_all_label_verified_ids_and_destroy_them(self):
        site = load("site.yml")[0]["tasks"]
        destroy = load("destroy.yml")[0]["tasks"]
        labels = {"pb_e2e": "true", "run_id": "test-run-123", "expires_at": "1999999999"}
        for kind in ("firewalls", "primary_ips", "servers", "volumes"):
            with self.subTest(kind=kind), self.controller() as work:
                block = copy.deepcopy(task_named(site, f"Create and journal {kind}"))
                create = block["block"][0]
                module = next(key for key in create if key.startswith(("ansible.", "hetzner.")))
                del create[module]
                create["fake_api"] = {"state_file": "{{ e2e_test_api_file }}",
                                      "kind": kind, "labels": labels}
                api = {
                    "resources": [
                        {"id": 99, "name": "pb-e2e-test-run-123", "labels": {"run_id": "foreign"}},
                        {"id": 98, "labels": {**labels, "pb_e2e": "false"}},
                        {"id": 97, "labels": {**labels, "expires_at": "1"}},
                        {"id": 100, "labels": labels},
                        {"id": 102, "labels": labels},
                        {"id": 103, "labels": labels},
                    ], "calls": [],
                }
                (work / "api.json").write_text(json.dumps(api))
                existing = {} if kind in ("firewalls", "servers") else {kind: "100"}
                result = self.run_tasks(work, [block], {"e2e_state": self.state(existing)})
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("accepted ids were journaled", result.stdout, result.stderr)
                journal = json.loads((work / "run/resources.json").read_text())
                self.assertEqual(journal["resources"][kind], [100, 102, 103, 101])
                self.assertEqual((work / "run/resources.json").stat().st_mode & 0o777, 0o600)
                calls = json.loads((work / "api.json").read_text())["calls"]
                self.assertEqual(len(calls), 3)
                self.assertTrue(all(f"/{kind}?label_selector=run_id%3Dtest-run-123&" in call["url"] for call in calls))
                self.assertTrue(all("name=" not in call["url"] for call in calls))
                # Run the actual teardown twice against the same API state and journal.
                for _ in range(2):
                    result = self.run_tasks(work, destroy)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                api = json.loads((work / "api.json").read_text())
                deleted = [int(call["url"].rsplit("/", 1)[1]) for call in api["calls"] if call["method"] == "DELETE"]
                self.assertEqual(deleted, [100, 102, 103, 101])
                self.assertEqual([r["id"] for r in api["resources"]], [99, 98, 97])

    def test_pin_assertions_for_both_image_modes(self):
        assertion = load("site.yml")[0]["tasks"][0]
        valid = {
            "e2e_candidate_commit": "a" * 40, "e2e_os_image_id": 123,
            "e2e_docker_version": "26.1.5+dfsg1-9", "e2e_containerd_version": "1.7.24~ds1-6",
            "e2e_runc_version": "1.1.15+ds1-2", "e2e_docker_buildx_version": "0.13.1+ds1-3",
            "e2e_cloudflared_version": "2026.1.0", "e2e_cloudflared_sha256": "b" * 64,
            "e2e_runner_cidrs": ["192.0.2.1/32"],
        }
        cases = [
            ("target_build", {}, None, True),
            ("ghcr", {}, "e2e_docker_buildx_version", True),
            ("target_build", {}, "e2e_docker_buildx_version", False),
            ("target_build", {}, "e2e_containerd_version", False),
            ("ghcr", {}, "e2e_runc_version", False),
            ("target_build", {"e2e_docker_buildx_version": "latest"}, None, False),
            ("ghcr", {"e2e_containerd_version": "latest"}, None, False),
            ("target_build", {"e2e_runc_version": "latest"}, None, False),
        ]
        for source, overrides, missing, success in cases:
            with self.subTest(source=source, overrides=overrides, missing=missing), self.controller() as work:
                variables = {**valid, "e2e_image_source": source, **overrides}
                if missing:
                    del variables[missing]
                result = self.run_tasks(work, [assertion], variables)
                self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)

    def test_docker_packages_for_both_modes_and_cli_layouts(self):
        for source in ("target_build", "ghcr"):
            for split_cli in (True, False):
                with self.subTest(source=source, split_cli=split_cli), self.controller() as work:
                    tasks = load("tasks/docker.yml")
                    for task in tasks:
                        if "ansible.builtin.apt" in task:
                            args = task.pop("ansible.builtin.apt")
                            task["ansible.builtin.set_fact"] = {
                                "e2e_test_packages": args.get("name", []),
                            }
                    tasks.append({"name": "Capture the package selection", "ansible.builtin.copy": {
                        "content": "{{ e2e_test_packages | to_json }}",
                        "dest": str(work / "packages.json"), "mode": "0600",
                    }})
                    (work / "apt-cache").write_text(f"#!/bin/sh\nexit {0 if split_cli else 100}\n")
                    (work / "apt-cache").chmod(0o700)
                    variables = {"e2e_image_source": source, "e2e_docker_version": "26.1.5",
                                 "e2e_containerd_version": "1.7.24", "e2e_runc_version": "1.1.15"}
                    if source == "target_build":
                        variables["e2e_docker_buildx_version"] = "0.13.1"
                    result = self.run_tasks(work, tasks, variables)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    expected = ["docker.io=26.1.5", "containerd=1.7.24", "runc=1.1.15"]
                    if split_cli:
                        expected.append("docker-cli=26.1.5")
                    if source == "target_build":
                        expected.append("docker-buildx=0.13.1")
                    self.assertEqual(json.loads((work / "packages.json").read_text()), expected)

    def test_destroy_refuses_ssh_keys_and_unknown_kinds(self):
        tasks = load("destroy.yml")[0]["tasks"]
        assertion = task_named(tasks, "Validate the journal identity and allowed resource kinds")
        deletion = task_named(tasks, "Attempt every resource in dependency order")
        self.assertEqual([item["kind"] for item in deletion["loop"]], ["servers", "volumes", "primary_ips", "firewalls"])
        for kind in ("ssh_keys", "networks"):
            with self.subTest(kind=kind), self.controller() as work:
                result = self.run_tasks(work, [assertion], {"e2e_state": self.state({kind: 42})})
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_destroy_removes_transport_files_even_when_a_resource_fails(self):
        with self.controller() as work:
            labels = {"pb_e2e": "true", "run_id": "test-run-123", "expires_at": "1999999999"}
            (work / "api.json").write_text(json.dumps({
                "calls": [], "resources": [{"id": 42, "labels": labels}], "fail_delete_id": 42,
            }))
            (work / "run/resources.json").write_text(json.dumps(self.state({"servers": 42})))
            for name in ("known_hosts", "candidate-source.tar", "id_ed25519", "id_ed25519.pub", "candidate.tar"):
                (work / "run" / name).touch()
            result = self.run_tasks(work, load("destroy.yml")[0]["tasks"])
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("Cleanup could not confirm absence", result.stdout, result.stderr)
            self.assertFalse((work / "run/known_hosts").exists())
            self.assertFalse((work / "run/candidate-source.tar").exists())
            for name in ("id_ed25519", "id_ed25519.pub", "candidate.tar"):
                self.assertTrue((work / "run" / name).exists())

    def test_readiness_diagnostics_are_private_and_never_printed(self):
        with self.controller() as work:
            tasks = load("tasks/ready.yml")
            poll = tasks[0]["block"][0]
            # Fail only the external readiness boundary, then execute the real rescue.
            poll.pop("ansible.builtin.uri")
            for key in ("register", "until", "retries", "delay"):
                poll.pop(key)
            poll["ansible.builtin.fail"] = {"msg": "simulated unready broker"}
            (work / "journalctl").write_text("#!/bin/sh\nprintf 'private-log-sentinel\\n'\n")
            (work / "journalctl").chmod(0o700)
            result = self.run_tasks(work, tasks)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("private-log-sentinel", result.stdout + result.stderr)
            log = work / "run/broker-readiness.log"
            self.assertEqual(log.read_text(), "private-log-sentinel")
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)
            self.assertIn(str(log), result.stdout)

    def test_tunnel_ignores_error_urls_and_extracts_only_the_announcement(self):
        with self.controller() as work:
            pattern = load("vars.yml")["e2e_tunnel_url_pattern"]
            tasks = [{"name": "Reject failure and arbitrary matching hostnames", "ansible.builtin.assert": {"that": [
                "failure | regex_findall(e2e_tunnel_url_pattern) | length == 0",
                "unrelated | regex_findall(e2e_tunnel_url_pattern) | length == 0",
            ]}}]
            publish = task_named(load("tasks/tunnel.yml"), "Publish the single discovered origin as a host fact")
            tasks += [publish, {"name": "Check the selected origin", "ansible.builtin.assert": {
                "that": "e2e_public_url == 'https://real-tunnel.trycloudflare.com'"}}]
            failure = '2026-10-21T12:00:00Z ERR Error requesting quick Tunnel: Post "https://api.trycloudflare.com/tunnel": timeout'
            announcement = '2026-10-21T12:00:01Z INF |  https://real-tunnel.trycloudflare.com  |'
            variables = {"e2e_tunnel_url_pattern": pattern, "failure": failure,
                         "unrelated": "INF Retrying https://wrong-host.trycloudflare.com",
                         "e2e_tunnel_log": {"stdout": announcement + "\n" + failure}}
            result = self.run_tasks(work, tasks, variables)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            poll = task_named(load("tasks/tunnel-attempt.yml"), "Wait at most one minute for this invocation's quick tunnel URL")
            self.assertIn("regex_findall(e2e_tunnel_url_pattern)", poll["until"])


if __name__ == "__main__":
    unittest.main()
