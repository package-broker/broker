# Security policy

## Reporting a vulnerability

Report vulnerabilities through GitHub private vulnerability reporting: open the Security tab of this repository and choose "Report a vulnerability", or e-mail [security@package.broker](mailto:security@package.broker). Do not open a public issue for a security problem.

Include the affected package and version or commit, the runtime (Cloudflare Workers or Node), steps to reproduce, and the impact you see. You will get an acknowledgement within five working days.

## Supported versions

Package Broker 2.0 is in release candidates. Reports against the latest `rc` release and the 2.0 `main` branch are accepted. Package Broker 1.x is end of life and receives no security fixes.

## Scope

In scope: everything in this repository, including the `pb` CLI, both runtimes, the first-party plugins and the generated build manifest. Out of scope: vulnerabilities in public registries or vendor repositories that Package Broker proxies, and findings that need a compromised deployment master key or write access to the database.
