import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]


class ProvisioningTests(unittest.TestCase):
    def test_server_uses_the_journaled_firewall_id(self):
        plays = yaml.safe_load((ROOT / "site.yml").read_text())
        server = next(
            task["hetzner.hcloud.server"]
            for task in plays[0]["tasks"]
            if "hetzner.hcloud.server" in task
        )
        self.assertEqual(len(server["firewalls"]), 1)
        # The module resolves each list element as a name or ID, not an API object.
        self.assertIsInstance(server["firewalls"][0], str)
        from jinja2 import Environment, StrictUndefined

        rendered = Environment(undefined=StrictUndefined).from_string(
            server["firewalls"][0]
        ).render(e2e_state={"resources": {"firewalls": 123456}})
        self.assertEqual(rendered, "123456")

    def run_image_preparation(self, capability, source="target_build"):
        tasks = yaml.safe_load((ROOT / "tasks/image.yml").read_text())
        digest_index = next(
            i for i, task in enumerate(tasks) if "ansible.builtin.slurp" in task
        )
        # Execute the real pre-build and build tasks with only the Docker boundary mocked.
        tasks = tasks[1:digest_index]
        (ROOT / "runs").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT / "runs") as directory:
            work = Path(directory)
            docker = work / "docker"
            docker.write_text(
                f"#!{sys.executable}\n"
                "import json, os, sys\n"
                "probe = '--iidfile' not in sys.argv\n"
                "stdin = sys.stdin.read() if probe else ''\n"
                "with open(os.environ['DOCKER_TEST_LOG'], 'a') as log:\n"
                "    log.write(json.dumps({'probe': probe, "
                "'buildkit': os.environ.get('DOCKER_BUILDKIT'), 'stdin': stdin}) + '\\n')\n"
                "if os.environ.get('DOCKER_BUILDKIT') != '1':\n"
                "    sys.exit(0)\n"
                "if os.environ['DOCKER_TEST_CAPABILITY'] == 'missing':\n"
                "    sys.exit(1)\n"
                "if probe and os.environ['DOCKER_TEST_CAPABILITY'] == 'old_frontend':\n"
                "    sys.exit(1)\n"
            )
            docker.chmod(0o700)
            log = work / "docker.jsonl"
            playbook = work / "probe.yml"
            playbook.write_text(yaml.safe_dump([{
                "name": "Exercise target builder selection without a daemon",
                "hosts": "localhost",
                "connection": "local",
                "gather_facts": False,
                "vars": {
                    "e2e_image_source": source,
                    "e2e_candidate_commit": "a" * 40,
                    "ansible_python_interpreter": sys.executable,
                },
                "tasks": tasks,
            }]))
            env = {
                **os.environ,
                "PATH": str(work) + os.pathsep + os.environ["PATH"],
                "DOCKER_TEST_LOG": str(log),
                "DOCKER_TEST_CAPABILITY": capability,
                "DOCKER_BUILDKIT": "0",
                "ANSIBLE_LOCAL_TEMP": str(work / "ansible-local"),
                "ANSIBLE_REMOTE_TEMP": str(work / "ansible-remote"),
                "ANSIBLE_NOCOLOR": "1",
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            result = subprocess.run(
                [os.environ.get("ANSIBLE_PLAYBOOK", "ansible-playbook"),
                 "-i", "localhost,", str(playbook)],
                env=env, capture_output=True, text=True, timeout=60,
            )
            calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            return result, calls

    def test_capable_builder_is_explicitly_enabled_and_probed_before_build(self):
        result, calls = self.run_image_preparation("supported")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual([call["probe"] for call in calls], [True, False])
        self.assertTrue(all(call["buildkit"] == "1" for call in calls))
        self.assertIn("FROM scratch", calls[0]["stdin"])
        self.assertIn("<<", calls[0]["stdin"])

    def test_missing_buildkit_prevents_candidate_build(self):
        result, calls = self.run_image_preparation("missing")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual([call["probe"] for call in calls], [True])
        self.assertIn("NOT RUN", result.stdout)

    def test_old_frontend_prevents_candidate_build(self):
        result, calls = self.run_image_preparation("old_frontend")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual([call["probe"] for call in calls], [True])
        self.assertIn("NOT RUN", result.stdout)

    def test_ghcr_does_not_require_a_builder(self):
        result, calls = self.run_image_preparation("missing", source="ghcr")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
