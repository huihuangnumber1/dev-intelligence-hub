# Open follow-ups for a smooth command-center workflow

This list records gaps identified in the September 2026 product and requirements review. It is a work queue, not a release acceptance report. Run-specific logs, credentials, account identities, and private runtime artifacts remain outside the repository. A finding is closed only when its acceptance check passes on the current source state.

## P1 — Show real running tasks and support in-task adjustments

The owner requested a clickable running-task list, supplemental instructions,
priority changes, pause, resume and cancellation. The source audit of
agent-feishu-bridge confirms that its live Codex steering uses the persistent
app-server protocol and `turn/steer`, bound to a thread and expected turn.
The explicit native `exec` route can only continue at a later checkpoint; that
compatibility behavior must not be presented as live steering.

The [source review and integration design](research/2026-10-13-agent-feishu-bridge-source-review.md)
records the transport, progress events, stale-turn protection and recovery
limitations. The registry, global running-task UI, origin/CAS protected HTTP
controls and role/code-worker integration are implemented. Focused checks cover
real ledger settlement, fixture stdio communication and an isolated Chromium
interaction. Windows native login now defaults to the contained App Server
transport with capability attestation and thread/turn-bound control. The earlier
activation blocker is superseded by that implementation; the explicit exec
transport retains checkpoint-only behavior. Bounded execution metadata now
survives restart; open receipts recover as unknown until stopping is proved.
Deployment and a live business-task acceptance check remain separate gates;
this entry is not closed by fixture or initialization-only success. Existing
runtime configuration is preserved.

**Acceptance:** demonstrate real task progress and turn-bound steering, reject
late or duplicate controls, preserve instructions and holds across restart,
confirm interruption before reporting a task stopped, and prevent stale output
from reaching code execution or GitHub publication. Keep priority changes within
the scheduler and preserve the existing task authorization and PR Head checks.

## P2 — Retire terminal task-control settings with authoritative evidence

The running-task registry preserves controls across restarts, but currently never
retires settings for finished tasks. After controls have been saved for 1,000
distinct entities, new entities cannot save their first control. Increasing the
limit or deleting the settings file would hide the lifecycle gap and could erase
pause/cancel barriers and supplemental instructions.

**Acceptance:** use fresh authoritative ledger/job terminal states to retire
eligible settings, retain active runs, paused tasks and unresolved controls, and
keep cancellation barriers until redispatch is impossible. Verify recovery from
capacity after terminal records are retired, including unavailable/stale store
evidence and restart. Preserve the current bounded-state validation. This is a
long-term lifecycle follow-up, not evidence that the current deployment has
reached capacity.

## P1 — Complete the real testing and repair loop

The tester role and verify code worker now load the portable bundled
`controlled-testing` workflow. Verify failures must settle after their durable
observation instead of repeating the same failed profile; retain bounded test
counts and distinguish verification failure, timeout, unavailable environment
and unknown cause. None of these classifications alone authorizes product-code
repair or produces a completed test-report.

Version-bound Windows assets now use LPAC, copied hashed resources and actual
token evidence; their Job Object lifecycle includes confirmed-stop cleanup.
Controlled product validation covers three OCT TaskQueue QtCore assertions and
106 stable Picasso assertions in a digest-pinned Docker image. These assets need
normal configuration activation in each deployment; repository preflight alone
remains insufficient. Full desktop/hardware workflows, a dedicated test-driven
repair source and separate developer/retest graph children remain open.
Do not reassign a test-report child to a developer or reuse old-Head results.

**Acceptance:** a real scoped PR fails an executed test, a separate developer
task repairs it, and a new-version retest passes with logs and evidence.
Environment failures and hardware-pending checks remain distinct; repeated
cycles/restarts cannot create duplicate repairs or tests. See [testing guide](TESTING.md).

## P0 — Restore supervised CLI task execution

The service can be healthy while a configured high-capability role cannot run because the Codex login broker reports `broker_blocked` and role cycles report `STRUCTURED_PROVIDER_CLEANUP_FAILED`. Diagnose the failed private mirror, process reap, or cleanup step without deleting retained sessions or changing the owner's login and configuration. Keep service readiness separate from role/provider execution readiness in the API and UI.

**Progress (2026-09-24):** A normal Codex CLI invocation exceeded the old 16 MiB cleanup bound. Commit `486f2c9564` raises the bounded cleanup limit to 64 MiB and adds regression coverage. After a consistent recovery snapshot, the retained invocation was preserved, the service restarted, the broker reported `available`, and a manual developer cycle completed. A later cycle still blocked with a retained login-status probe. Its exact failure phase was not captured. The probe cleanup deadline is now 30 seconds instead of 10, and safe stage-only warnings distinguish cleanup preparation, cleanup commit, and unconfirmed process exit. Continued live operation must confirm whether this resolves the intermittent failure. The remaining readiness presentation, forced-failure acceptance check, and per-item reconciliation still need verification.

**Progress (2026-09-29):** A retained invocation contained about 66.5 MiB: a successfully saved session plus SQLite state exceeded the aggregate 64 MiB cleanup bound. The saved and retained rollout hashes matched, but the old marker still required session recovery and blocked other roles sharing the root. Cleanup now accounts for captured session bytes under the existing session storage limit, with a separate 64 MiB transient allowance. A completion receipt and read-only saved-history verification distinguish an archived residue from the only copy of interrupted progress. Legacy evidence requires preservation during maintenance; this change does not settle pending owner consultations or prove all role workflows complete.

**Reproduced (2026-10-12):** A compatibility-path fixture failed during session
preparation before a vendor process started. Preparation settled and its task
directory was removed, but the shared credential lease was released as unsafe;
the next independent attempt failed with `STRUCTURED_PROVIDER_CLEANUP_FAILED`
without starting a process. This is a confirmed pre-process fencing defect.
The live service separately reported `broker_blocked`; available historical
diagnostics do not prove that this fixture path caused the first live failure.
The correction must prove preparation has settled, no process can subsequently
start and cleanup is verified before releasing the lease. In-flight preparation,
unknown process termination, credential publication and cleanup failures must
remain fenced. Reproduction is not a passing regression or live acceptance
receipt; record those separately after integration.

**Verified in fixtures (2026-10-12):** Settled preparation failure now releases
the compatibility lease only after verified cleanup; a subsequent independent
task succeeds. Unsettled preparation, uncertain reaping and failed cleanup stay
fenced. Native-provider fixtures verify direct use of the original home,
entity-bound resume across provider recreation, cancellation after reaping,
per-entity reference recovery and complete immutable PR reads. A separate
regression reproduced the runner rejecting the provider's 64 MiB trace budget
before spawn; stdout admission now matches that budget and a 2 MiB trace passes.
These are fixture receipts, not evidence that a real PR has been published.

**Live observation (2026-10-12):** The existing service still reports
`broker_blocked` through the no-model readiness endpoint. Its private
configuration remains unchanged; native mode has not been activated and this
observation does not attribute the first live failure to one reproduced defect.

**Native installation check (2026-10-12):** A separate no-model probe using the
real official CLI locator, private-directory manager and supervised process
runner returned native `available`. Only a newly created probe parent received
private ACLs; existing configuration, login and history were unchanged. An
ordinary TEMP/profile parent failed the directory trust check before CLI
startup. This validates native installation/login in a trusted runtime root,
not the active service's role execution, model output or GitHub publication.

**Native execution check (2026-10-12):** The official CLI completed an ephemeral
synthetic `gpt-6.1-sol` task, then a separate two-turn entity-bound task recovered
the random marker from its first turn using the same native conversation. These
checks supplied no project content and performed no GitHub operation. Original
history was preserved; the synthetic conversation and its references remain
private validation evidence. The configured-router regression also confirms
that the pinned PR target reaches the native reader and incomplete reading is
rejected. This does not replace a real PR publication/handoff acceptance check.

**Native resumed-tool check (2026-10-12):** Two real CLI turns used the actual
loopback MCP reader with synthetic GitHub responses. After resume, the second
turn discovered its newly created endpoint, fully read that turn's manifest and
diff, and returned the updated pinned source value. No real PR was read or
published. Adversarial sandbox enforcement and business publication/handoff are
still separate acceptance gates.

**Implemented direction (2026-10-12):** Explicit `codex-native-login` alongside unchanged
compatibility/API-key modes. Codex owns authentication and conversation files;
the service owns task/session references, supervised invocation, scoped
read-only review tools and validated results. No auth or session-directory
copies, automatic mode fallback, historical-session migration or private
configuration change is part of this opt-in route. Code modification and tests
still use the controlled executor. This direction does not establish that all
real PR workflows are unblocked; validate readiness, model execution, Review
publication and handoff as separate steps.

**Done when:** the bounded no-model readiness check reports `available`; one real configured role completes a bounded task and records its result; a forced broker failure leaves work unclaimed, explains the blocker to the owner, and preserves private evidence. Confirm that previously blocked work is reconciled by its own reason rather than bulk-retried.

## P1 — Prevent sensitive imported sessions from reaching remote brains

Local session import preserves transcript text, and memory answering can include retrieved records in a remote prompt after broad data-class authorization. Define a separate egress rule for imported sessions. Default imported transcripts to local-only, or require an explicit reviewed export decision for a bounded, sanitized subset. Preserve local search and citations.

**Done when:** a credential-bearing imported record causes zero remote provider calls while local retrieval still works; tests cover mixed safe and restricted records and provider switching.

## P1 — Make final acceptance internally consistent

U12 lists AE1–AE8 but omits the supervised CLI acceptance example AE9. Its zero-GitHub-write verification sentence also overlaps the separately authorized product-run live PR gate. Define a local fake-adapter, zero-write gate and a distinct owner-authorized product-run gate. Bind both to the same current source-state evidence without treating one as proof of the other.

**Done when:** AE9 is exercised in U12, the two gates have separate evidence and authorization rules, and release status cannot become complete from simulated or stale results.

## P1 — Give the owner a single actionable view of each work item

For each PR or Issue task, show the current responsible party, source status, blocker and its cause, next action, linked evidence, and freshness. Add safe per-item controls for pausing, cancelling, or requesting reassignment of local AI work. Keep a GitHub Assignee change under its own external-action policy, including the explicitly enabled automatic Review handoff. Reconcile stale merged or closed PRs and supersede old Head-bound work.

**Done when:** an owner can identify and act on one queued, waiting, or blocked item without pausing an entire role; a merged PR cannot remain presented as an active action; independent tasks continue when one task blocks.

## P1 — Make manual role runs observable and bounded

The current `立即巡查` request waits for the whole role cycle. A PR-role run exceeded a 180-second client timeout while a scheduled cycle was also active; the HTTP result did not explain whether work was queued, still running, or finished. Return a short-lived run identity promptly, show queued/running/terminal state and the latest result, and make repeated clicks attach to the same in-flight cycle when appropriate.

**Done when:** a manual run receives a prompt, stable acknowledgement; the UI can follow its final outcome after a slow cycle or client disconnect; a timed-out browser request cannot create an ambiguous duplicate run.

## P2 — Remove duplicate attention without weakening confirmations

Consultations and ordinary external actions stay in the one-at-a-time queue.
Explicit automatic Review and own-PR repair policies remove individual prompts
only within their declared scope and preserve audit evidence. Coalesce only
duplicate requests for the same semantic action, target, source revision, and
authority; preserve distinct authorization boundaries for Review, code
application, push and merge.

**Progress (2026-09-29):** Pending internal consultations now gain an explicit archive record after a historically bound producer task is cancelled, completed, or superseded. Startup and coordination maintenance retain the question and audit evidence without emitting an answer or retry. Browser deferral bindings now reach the inbox runtime. Session recovery failures show maintenance instructions and “retry after repair”; the underlying session recovery fault and shared fault presentation still need repair. This change does not compact retained audit history or coalesce distinct approvals.

**Done when:** repeated refreshes and employee cycles show one pending request per unchanged action, while a changed Head or changed proposal requires a new decision and old requests become stale.

## P2 — Define DingTalk report quality and task intake

Retain the Shanghai-time 09:00 daily overview and 12:00, 15:00, 18:00, and 20:00 updates. Specify source freshness, partial-data labeling, deduplication, links to evidence, and which messages or TODOs create shared work. A source error should produce a short actionable summary in the UI, with details confined to diagnostics.

**Done when:** each scheduled report distinguishes new progress, unchanged items, blockers, and missing sources; retrying a source does not duplicate tasks or expose a raw provider error on the dashboard.
