"""Ansible module simulating an accepted create followed by a lost response."""

import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from ansible.module_utils.basic import AnsibleModule


def main():
    module = AnsibleModule(argument_spec={
        "state_file": {"type": "path", "required": True},
        "kind": {"type": "str"},
        "labels": {"type": "dict"},
        "url": {"type": "str"},
        "method": {"type": "str", "default": "GET"},
    })
    path = Path(module.params["state_file"])
    state = json.loads(path.read_text())
    if module.params["kind"]:
        state["kind"] = module.params["kind"]
        state["resources"].append({"id": 101, "labels": module.params["labels"]})
        path.write_text(json.dumps(state))
        module.fail_json(msg="Simulated lost response after provider acceptance")
    url = urlparse(module.params["url"])
    state["calls"].append({"url": module.params["url"], "method": module.params["method"]})
    path.write_text(json.dumps(state))
    if not url.query:
        resource_id = int(url.path.rsplit("/", 1)[1])
        resource = next((r for r in state["resources"] if r["id"] == resource_id), None)
        if resource and resource_id == state.get("fail_delete_id"):
            module.fail_json(msg="Simulated unavailable resource", status=503)
        if resource and module.params["method"] == "DELETE":
            state["resources"].remove(resource)
            path.write_text(json.dumps(state))
            module.exit_json(status=204)
        if resource:
            singular = {"servers": "server", "volumes": "volume",
                        "primary_ips": "primary_ip", "firewalls": "firewall"}[url.path.split("/")[-2]]
            module.exit_json(status=200, json={singular: resource})
        module.exit_json(status=404)
    query = parse_qs(url.query)
    selector = query["label_selector"][0]
    key, value = selector.split("=", 1)
    resources = [r for r in state["resources"] if r["labels"].get(key) == value]
    # Small pages exercise recovery across multiple API responses.
    page = int(query["page"][0])
    start = (page - 1) * 2
    module.exit_json(status=200, json={
        state["kind"]: resources[start:start + 2],
        "meta": {"pagination": {"next_page": page + 1 if start + 2 < len(resources) else None}},
    })


if __name__ == "__main__":
    main()
