# Project status

Development Intelligence Hub is currently a pre-stable, local-first project.
The repository version is `0.1.0`. APIs, workflow contracts, configuration
schemas, and documentation may change before the first stable release.

## Capability status

| Area | Status | Current boundary |
| --- | --- | --- |
| Local dashboard and source aggregation | Implemented | Safe example configuration keeps all real sources disabled. |
| Versioned routing and durable work ledger | Implemented | Routing assigns work but cannot grant model, executor, or GitHub authority. |
| Orchestrator and specialist roles | Implemented | Roles start paused and require explicit configuration and provider availability. |
| Cited local memory | Implemented | Remote use remains subject to explicit requirements, code, and memory data grants. |
| Controlled code jobs and change packages | Implemented | Execution occurs in an isolated copy; applying a package requires a separate confirmation. |
| GitHub reviews and PR actions | Implemented behind confirmation | Every write is bound to an account, repository, PR, and exact Head. |
| Versioned configuration and recovery | Implemented | Security-relevant changes invalidate affected authority and require a managed restart. |
| Open-source distribution baseline | Verified | Apache-2.0, safe example configuration, tracked-tree privacy checks, and clean installation are covered. |
| Whole-system U12 acceptance | Pending | Current Docker, browser, recovery, independent review, and product-run live PR evidence must be completed on one clean source state. |

Detailed requirements and historical verification notes are maintained in
[`DEVELOPMENT_PLAN.md`](../DEVELOPMENT_PLAN.md) and the authoritative
[U1–U12 plan](plans/2026-08-02-001-feat-complete-command-center-plan.md).
The current product and requirements gaps are tracked in
[open follow-ups](OPEN_FOLLOWUPS.md).
Maintainers preparing a public version should also use the
[release checklist](MAINTAINER_RELEASE_CHECKLIST.md).

## Supported operating model

- The service is a single-user application that listens only on `127.0.0.1`.
- Node.js 22 or newer, npm, and Git are required.
- The managed lifecycle is Windows-oriented and uses PowerShell. Plain
  `npm start` is available for foreground development diagnostics.
- Ollama, third-party model providers, Docker Desktop, GitHub access, and
  collaboration-system integrations are optional and disabled until configured.
- The current Docker test library runs fixed Node profiles. Windows, Qt, and
  FastBuild workloads require a future controlled Windows sandbox and are not
  executed through unrestricted host PowerShell.

## Release readiness

Before calling a commit release-ready, maintainers must complete the acceptance
contract in [`validation-notes.md`](../validation-notes.md):

1. Run the core and complete system validators from one clean commit.
2. Include Docker and current desktop/mobile browser evidence.
3. Complete both required independent reviews with no unresolved P0/P1/P2 findings.
4. Generate a HEAD-bound system acceptance manifest.
5. Complete the separately authorized product-run external acceptance gate.

Run-specific reports, screenshots, logs, private configuration, credentials,
repository identities, and local memory are operational data. They belong in
the ignored local directories and must never be committed.
