# Operations

Development Intelligence Hub is a single-user, loopback-only service. Keep the project, active
data, backups, restore control state, and managed-process runtime on trusted
local storage. Do not publish port 4173 through a proxy, port forward, or LAN
listener.

The optional read-only LAN view uses a separate listener on port 4174. From the
local dashboard, open **局域网查看**, enter the host's private IPv4 address
and the exact private IPv4 addresses of colleagues' devices, then apply the
settings. Allow inbound TCP 4174 from those addresses if the Windows firewall
blocks access. It uses the standard dashboard interface with projected read
endpoints for GitHub work, employees, workflow, work records, test inventory,
and task state. DingTalk content, memory search, CLI transcripts, management
configuration, and mutation endpoints are reserved for the local interface.
It uses the TCP peer address for admission. Disabling the board closes its
listener and active connections. Applied settings are saved locally and restored
after service restart. A changed host address or occupied port leaves the LAN
listener closed with an actionable error; the saved addresses remain editable.

## Prerequisites

- Node.js 22 or newer and `npm`.
- PowerShell 5.1 or newer for the managed lifecycle commands.
- A private `config.json` only when first importing accounts, providers, or
  privileged capabilities. A fresh checkout safely falls back to
  `config.example.json`; after an active version exists, use the structured
  configuration UI and owner-confirmed activation instead of editing bootstrap
  files.
- Credentials supplied only through the environment variables named by the
  private configuration.
- For supervised CLI brains, the first release requires Windows x64 and an
  official npm installation discoverable from the managed service account's
  `PATH`: an official Codex CLI package, or Claude CLI `>=2.1.222 <2.2.0`.

Install and verify before the first managed start:

```powershell
npm ci
npm test
```

For a repeatable release or upgrade acceptance, run the core validation from a
committed tree. It checks every committed Node test, JavaScript syntax, and the
configuration and confirmation browser fixtures:

```powershell
npm run setup:validation-browser
npm run validate:system
```

The setup command is required only after the first install or a Playwright
upgrade. It stores the matching Chromium headless shell under the ignored
`data/playwright-browsers/` directory. Validation never falls back to a host
browser profile or downloads a browser during an acceptance run.

The complete host gate additionally requires Docker Desktop and a healthy
managed service already listening on `127.0.0.1:4173`:

```powershell
.\scripts\Manage-MyDashboard.ps1 -Action Start
npm run validate:system -- --all
```

Validation must start from a clean committed worktree. It fails if HEAD, the Git
tree, or tracked/untracked source changes during the run. Ordinary Node tests
run from a read-only materialization of the exact commit without `.git`. The
open-source distribution suite, which must inspect the Git index, current tree,
and package payload, runs separately from the repository after clean
commit/tree verification before and after the command. Both suites are
mandatory and together cover every committed top-level Node test. The command
writes a new machine-readable result for every run and prints its ignored path:
`validation-artifacts/runs/<runId>/system-validation.json`. The report includes
the start/end source identity, sanitized logical commands and exit status, and
Node pass/fail/skip identities. An `--all` run stores its structured UI result,
real PNG screenshots, and verified receipt under the same run directory. Runs
never overwrite one another. The immutable Node suite uses a fixed concurrency
of four test files so process-lifecycle and timeout checks remain reproducible
under host load; the Git-context distribution suite runs alone with concurrency
one.

After `--all` and two independent final reviews have passed, bind those records
to the same HEAD with:

```powershell
node scripts/system-acceptance-manifest.mjs `
  --validation-report "validation-artifacts/runs/<runId>/system-validation.json" `
  --review "security-reliability=validation-artifacts/runs/<runId>/reviews/security-reliability.json" `
  --review "maintainability-usability=validation-artifacts/runs/<runId>/reviews/maintainability-usability.json"
```

Each review file is a release-owner attestation recording the result of a
distinct reviewer execution after that validation run. The two exact scopes are
`security-reliability` and `maintainability-usability`. Each report binds the
same run ID, HEAD, tree, and validation-report SHA-256; carries unique review,
reviewer, and reviewer-run identities; declares verdict `ready`; and reports
zero P0, P1, and P2 findings. The manifest validates those bindings,
chronology, and uniqueness claims; it does not authenticate a reviewer or prove
execution independence. Retain the trusted orchestrator's original run records
and have the release owner verify them before creating the attestations.

The ignored
`validation-artifacts/runs/<runId>/system-acceptance-manifest.json` records the
validation commands and test identities and hashes the validation report, UI
results/screenshots, and both distinct review reports. It is published once and
never overwrites an existing manifest. Manifest creation fails for a stale or
dirty HEAD, a misplaced or partial validation report, missing Docker/live UI,
a failed command, missing UI evidence, or invalid reviews. Treat all local
artifacts as private operational data until reviewed and sanitized. The
manifest does not choose a license or replace the owner-confirmed product-only
live PR acceptance.

The current-tree privacy gate does not erase sensitive data from earlier Git
commits. Before the first public source release, review the complete history or
publish a verified, squashed source export into a new public repository. Never
push this private development history merely because the current tree passes.

## Managed lifecycle

### Running-task controls and optional Codex app-server

`GET /api/task-runs` projects actual in-process model turns and controlled code
actions. Queued ledger items are not presented as running. The detail endpoint
`GET /api/task-runs/{kind}/{taskId}` and origin-checked control endpoint
`POST /api/task-runs/{kind}/{taskId}/control` use a run ID and settings revision
to reject stale controls. Adjustment settings and holds live in the existing
data directory as `task-run-settings.json`; preserve this file in backups.

On Windows, native login now defaults to the contained app-server transport.
`DIH_CODEX_NATIVE_TRANSPORT=exec` selects checkpoint compatibility;
`app-server` explicitly selects live operation. Other platforms retain exec.
This applies only to `codex-native-login`, preserving authentication, configured
models/effort, the original `CODEX_HOME` and entity thread references. New durable
threads request legacy history; existing threads resume by their exact ID.

The same Windows Job Object wrapper now carries a framed invocation header and
persistent stdin. It assigns the verified binary to its Job Object atomically
at process creation, retaining the existing termination proof and limits.
Direct-child exit is not substituted for tree cleanup. Live instructions use
`turn/steer` with the current thread and expected turn ID. Acknowledgements must
return that exact turn ID; they do not prove semantic adoption.

App-server does not support exec's ignore-config/rules flags. It also cannot
strictly validate an entire older personal config without rejecting unrelated
retired keys. The adapter instead verifies its effective capability settings,
the returned read-only/no-network sandbox, and the MCP inventory before a turn.
It disables inherited MCP servers individually. Review/decision invocations expose
three pinned read tools; continuous code invocations expose exactly
`perform_action`, `read_source`, and `get_state` under a separate fresh namespace.
Shell, hooks, plugins, apps and
external actions remain disabled; the code-mode host stays enabled because it
routes the scoped MCP tools. Review skills are passed explicitly, and personal agent
role files are replaced for this invocation with a trusted read-only profile.
No original configuration file is edited. Home `AGENTS.md` can still be loaded
as guidance; do not describe this as completely ignoring personal instructions.
Structured results retain no action authority. No CLI version string is a gate.

Code jobs on this route use one model turn for several audited executor actions.
This capability is selected by the native App Server adapter without rewriting
configuration, grants, models, effort, login, or retained session references.
Continuous native code execution has no total wall-clock deadline. Useful
current-turn progress renews a model inactivity watchdog; a task can keep working
for more than ten hours. Startup, RPCs, individual host actions, fixed test
profiles and process-tree cleanup retain their own bounds. Polling, stale events
and repeated tool results do not prove new progress. The job's audited action
limit still applies.
Other transports retain the previous one-action model decisions.

Model inactivity allows at least 15 minutes, or the longer configured provider
timeout. A host callback has a separate 30-minute hang bound because it includes
repeated authority checks and paginated repair feedback; a profile callback adds
the existing ten-minute executor allowance. The native MCP tool deadline is
41 minutes so it does not cut off those host bounds. These bounds do not extend
the profile process's own timeout or guarantee arbitrary feedback pagination fits.

After a native inactivity timeout, the worker can continue the same active job
only when its durable receipt proves the native process and admitted host actions
stopped, the checkpoint has no unresolved action, and current authority and
workspace checks still pass. It preserves the job, observations, changes and
successful verification results. Retry metadata and backoff survive restart;
three consecutive timeouts without new source, workspace or verification evidence
pause the task with an explanation. Elapsed task age does not consume this budget.
Existing paused jobs are not automatically adopted: their records do not identify
whether an operator intended the pause. User pause/cancel and uncertain side
effects remain reconciliation holds.

Monitor one actual job after deployment: it should keep one thread/turn while
multiple action observations appear, then produce the normal result/memory/package
records. In the running-task detail, verify steering receipts and new progress.
Undelivered saved instructions keep the job active for a subsequent turn, without
repeating audited actions. Once final completion has won the task-control fence,
new instructions receive `TASK_RUN_INSTRUCTIONS_CLOSED`; they are not silently
saved and discarded. Pause/cancel controls remain available during finalization.
A stop first denies new actions, drains already admitted actions and verifies
native process-tree exit. `stopUnconfirmed` or an unknown action is a reconciliation
hold, not a successful pause. Do not clear it or delete session history to resume.
Unexpected direct writes, duplicate actions, stale source pages or a premature stop
confirmation are rollback triggers. Pause the affected job, preserve evidence,
reconcile the action, and use the compatibility transport during a managed restart.
Synthetic tests and real PR acceptance are recorded separately in
[continuous development validation](validation/2026-10-14-continuous-codex-development.md).

Real native-model acceptance verified same-turn steering, exact-thread resume,
and T2 review with two independent reviewers and complete pinned reads, without
GitHub writes. See [live CLI validation](validation/2026-10-14-live-cli-session.md).
Before-turn failures after confirmed cleanup can clear only a fresh, unused
session journal; uncertain process termination remains fenced.

The task API adds a separate read-only `background` group for active/starting
code jobs between model steps. Its last eight action facts exclude source text
and grants. Real model/held runs take precedence, and background details cannot
submit controls using their synthetic display ID. Live session metadata and the
bounded 120-event transcript remain process-private and are not written to the
durable adjustment settings.

Code actions are observed without replaying them when requirements change.
Pause/cancel requests remain pending until the ledger or controlled executor
confirms settlement. Scheduled coordination explicitly reconciles retained
controls; pausing/cancelling/unknown code jobs remain eligible for recovery,
even when new execution is held. Never clear a hold to bypass an uncertain
executor result. `exec` instructions are applied at a later checkpoint.

An accepted pause/cancel takes precedence over an ordinary model failure, so a
retry cannot replace its original claim. `STRUCTURED_PROVIDER_REAP_FAILED`
retains a durable stop-unconfirmed hold across restart. Coordination may settle
it only after trusted native-provider readiness confirms recovery in a deployment
where all configured CLI providers use the same native Codex home/fence. Mixed
legacy/Claude CLI configurations cannot use that evidence; an absent in-memory
run is not stop evidence. Other providers need maintenance evidence
and must not have this hold cleared automatically. A code job already in a
terminal state wins a late control and keeps its actual final status.
An owner stop may settle that exact claim after its worker lease expires;
revision, lease identity and active-intent checks still prevent changing a newer
execution. This exception permits stopping, never worker execution.

Post-deploy checks: open the global running list, verify that an actual task
appears and a queued one does not, submit a harmless supplemental requirement,
and inspect its receipt. Verify pause/resume uses the same item and that a
cancelled code job remains pending until executor reconciliation. Watch stable
`TASK_RUN_*` and `STRUCTURED_PROVIDER_*` diagnostics. On an unconfirmed process
exit, preserve the invocation marker and native history; use the existing
managed recovery procedure. A healthy web endpoint alone is not acceptance of
real PR review or code execution.

Run lifecycle commands from the project root. The manager serializes concurrent
operations, authenticates the exact managed process, and does not force-kill a
process whose shutdown outcome is unknown.

```powershell
.\scripts\Manage-MyDashboard.ps1 -Action Status
.\scripts\Manage-MyDashboard.ps1 -Action Start
.\scripts\Manage-MyDashboard.ps1 -Action Start -OpenBrowser
.\scripts\Manage-MyDashboard.ps1 -Action Restart
.\scripts\Manage-MyDashboard.ps1 -Action Stop
```

`Start-MyDashboard.ps1` is a compatibility wrapper for `Start`. `Status`
returns a non-zero exit code for stopped, retained-uncertain, identity-mismatch,
or otherwise unhealthy managed state. Treat retained control state as evidence
to investigate; do not delete it merely to make `Start` succeed.

On slow storage or with large persisted state, use `-TimeoutSeconds 1800` for
`Start` or `Restart`. This extends the manager's observation window; the child's
bounded unclaimed-process watchdog and authenticated claim checks still apply.

On Windows, the launcher explicitly detaches from the command host's Job Object
so closing the terminal or automation command does not terminate the service.
If the host forbids job breakaway, startup fails before application code runs;
use a standalone PowerShell terminal that permits breakaway. The service remains
managed through the authenticated `Status` and `Stop` commands above.

### Failed-shutdown recovery

`Restart` never overrides retained lifecycle uncertainty. Recovery preparation
accepts two bounded cases: an authenticated managed process that is still alive
and has emitted authenticated requested/`failure` receipts, or an authenticated
control generation whose exact process identity is already absent. The latter
may carry the same complete failure-receipt pair, or no receipts at all after an
unexpected exit; a partial pair is never accepted. The controlled port must be
unused and the recorded generation must have no visible descendants:

```powershell
.\scripts\Manage-MyDashboard.ps1 -Action PrepareFailedShutdownRecovery
```

Preparation rejects changed receipts, a reused PID/process identity, an IPv4
or IPv6 loopback listener, visible managed child processes, links, unexpected
data nesting, and files that change while they are copied or verified. Managed
external executors use Windows Job Objects so their descendants are reaped with
the supervised invocation; recovery does not treat an arbitrary uncontained
same-user process as belonging to MyDashboard. Preparation creates a
byte-exact observational snapshot of root state files and an
authenticated `pre_termination` incident in the private runtime. It does not
restore data, terminate a process, remove lifecycle evidence, restart the
service, or open a browser. Record the exact snapshot identifier emitted by the
command. A preparation failure removes its unpublished temporary snapshot and
leaves the managed process and lifecycle barrier intact. When the exact process
is already absent, preparation acquires the production application writer lease
before capture and holds it through snapshot and incident publication. A
no-receipt incident uses the dedicated
`managed_process_exit_without_receipt` snapshot reason and HMAC-bound absence
digests for both receipt paths. A receipt that appears later durably transitions
the HMAC-authenticated incident to `invalidated`; deleting that receipt cannot
revive the old recovery authority.

The exact regular active directories `change-packages` and `code-executor`
are managed components preserved in place, outside this root state snapshot.
Their nested files are neither copied nor authenticated by the lifecycle snapshot;
they are not regenerable caches. Root state references to executor artifacts remain
byte-checked, and executor startup separately validates referenced audit artifacts
before recovering sessions. The comprehensive backup checkpoint continues to
include durable executor artifacts. Only the active data directory permits these
exact names: links, wrong-case aliases, same-name files, unknown directories, and
directories inside the snapshot remain rejected.

After inspecting that evidence and granting a separate, snapshot-specific
authorization, an operator may explicitly recover the failed lifecycle state:

```powershell
.\scripts\Manage-MyDashboard.ps1 -Action RecoverFailedShutdown `
  -RecoverySnapshotId shutdown-failure-YYYYMMDD-HHmmss-<32-lowercase-hex>
```

The recovery command accepts no browser option and leaves the service stopped.
It checks the snapshot manifest and active `data/` files byte-for-byte,
terminates only the PID whose executable path and process start time still
match a live authenticated control generation, verifies the project writer
lease can be acquired, holds it through final data validation and exact control
removal, and checks the snapshot against active data again after exact process
exit. An unexpected-exit snapshot is a
zero-termination authority: if the exact generation appears live, recovery
refuses instead of calling process termination. Before its final control removal,
the manager atomically reserves both absent receipt paths with exclusive,
delete-on-close barriers, so neither a requested nor terminal receipt can race
the finalization window. Only then does it durably finalize the incident,
reconcile the matching receipts, and remove the exact control state as the final
safety-affecting step. Any uncertainty before termination leaves
the process and evidence intact. A failure after termination retains the
control barrier and authenticated incident evidence; a retry can resume only
from that matching incident. An arbitrary, malformed, partially receipted, or
PID-reused dead control state is not recoverable.
Inspect the incident record before taking a separate explicit `Start` action.
Never delete private lifecycle evidence to bypass these checks.

Both `npm start` and managed startup use a bootstrap that captures the packaged
runtime identity before importing the application and verifies it again before
opening the service. A Git checkout must be clean and binds its real commit and
tree. A clean npm/offline payload without `.git` receives a deterministic
identity from its declared package files. Any source change during module load
fails startup closed. Git-backed startup also binds a process-private HEAD
reflog digest, so an ordinary commit, checkout, or reset from A to B and back to
A still fails. This check supplies consistency evidence; it does not defend
against an actively malicious process using the same operating-system account,
which is inside the documented trust boundary. Do not edit or switch the
checkout while starting the service.

The manager stores private process identity and bounded diagnostics outside the
repository. On Windows the root is:

```text
%LOCALAPPDATA%\MyDashboard\runtime\<project-digest>\
```

On non-Windows systems it is under
`$XDG_RUNTIME_DIR/mydashboard/<project-digest>/` when `XDG_RUNTIME_DIR` is an
absolute path; otherwise it falls back to
`~/.local/state/mydashboard/runtime/<project-digest>/`. `logs/server.log` is
rotated at 5 MiB with at most four archives. Logs, screenshots, backups, and
state may contain private engineering data; sanitize them before sharing.

## Supervised Codex and Claude CLI brains

The configuration UI contains safe templates for `codex-cli` and `claude-cli`.
Do not configure an executable, command, arguments, working directory, base URL,
API-key name, plugin, or MCP server. Production discovery accepts only the
official npm package shape and native executable. Codex discovery does not pin
a release range; each invocation validates the command protocol, structured
response, process exit, and cleanup contract. An unsupported,
missing, replaced, linked, or unverifiable binary remains unavailable.

Choose one explicit credential mode before `Start` or `Restart`:

- Native Codex `credentialMode: "codex-native-login"` uses the service account's
  startup `CODEX_HOME`, or its default Codex home, directly. Codex manages login
  refresh and conversation storage. MyDashboard stores session references only;
  it does not copy auth files, publish a private mirror, or copy session trees.
- Compatibility Codex `credentialMode: "codex-login"` proxies the current
  service user's file login. If `CODEX_HOME` existed when the service started,
  that absolute directory is the fixed source root; otherwise the source is the
  same Windows user's default Codex directory. Configuration and browser input
  cannot select or override this path.
- Backward-compatible Codex `credentialMode: "api-key"` reads only
  `OPENAI_API_KEY`. A missing mode remains API-key so an old configuration never
  silently changes account or billing path.
- Claude CLI supports only `credentialMode: "api-key"` and reads only
  `ANTHROPIC_API_KEY`. Claude login profiles, `CLAUDE_CODE_OAUTH_TOKEN`, and OS
  keyring export are not supported in the first release.

Keep API keys in the operating-system or service environment, not in
`config.json`, the configuration UI, scripts, logs, or command history. The
managed service must inherit the vendor package's npm binary directory in its
`PATH`. The service constructs a bounded mode-specific child environment; it
does not pass its GitHub credential source to the model process.

Compatibility `codex-login` requires an existing regular `auth.json` owned by the same Windows
user, with one link, a bounded size, no linked ancestor, and no unauthorized
write/delete/owner/ACL rights. MyDashboard does not change the host file or its
ACL. It copies only the validated authentication bytes into a private atomic
mirror outside project, data, backup, restore, and code-workspace roots. The
mirror is never logged, backed up, restored, or packaged. All login-mode Codex
calls for that service user are serial. Running `codex login`, switching the
account, or `codex logout` is detected at the next task boundary; refreshed
credentials stay in the private mirror and are never written back to the host.

In **配置**, add a CLI Provider, assign it and an explicit model to a role's
routine brain or task brain, and authorize each required remote data class
(`requirements`, `code`, `memory`) separately. CLI providers are always remote;
the remote flags are not editable. Validate the draft, inspect its impact, and
confirm activation one item at a time. The active runtime is immutable, so use:

```powershell
.\scripts\Manage-MyDashboard.ps1 -Action Restart
```

after activation. Resume only the intended role after readiness returns.

Run the fixed no-model readiness check against the managed loopback service:

```powershell
node scripts/verify-codex-login-readiness.mjs --origin http://127.0.0.1:4173
```

The command performs one bounded GET to the sanitized status endpoint. Compare
the reported credential mode with the active configuration when diagnosing a
mode change. Readiness is an installation/login check, not proof that a real
model call, PR Review, code job, or GitHub handoff succeeded. It does
not invoke a model, inspect a repository or PR, accept credentials/headers, or
print response details. A cold Windows CLI startup can take tens of seconds; the
command keeps a 90-second client deadline while the broker retains its shorter
bounded process and cleanup deadlines. Success prints exactly one of these
states:

- `available`: the supported CLI and the selected login route passed readiness;
- `file_login_unavailable`: the selected login is unavailable; compatibility
  mode requires file storage, while native mode checks the CLI login status;
- `unsafe_source`: the login file identity, owner, ACL, links, or size is unsafe;
- `broker_blocked`: compatibility mirror publication, integrity or cleanup is
  blocked; in native mode it means execution/session state needs maintenance,
  without implying a private credential mirror exists;
- `cli_unavailable`: the fixed supported Codex CLI package is unavailable.

For compatibility `file_login_unavailable`, run `codex login` under the same
Windows user and select file credential storage. Native mode uses the CLI's
login in the fixed native home; check it under the service account, with the
same startup `CODEX_HOME`. For `unsafe_source`, inspect and intentionally
repair ownership/ACLs outside MyDashboard; the service will not weaken them for
you. For `broker_blocked`, retain the private runtime evidence and investigate
before retrying. For `cli_unavailable`, install a supported official npm version
in the managed service account's `PATH`. Restart only when configuration state
says a confirmed active version is pending restart.

Each claimed task starts at most one vendor process. It runs in a fresh private
task directory. Compatibility routes isolate the profile and disable host tool
integration. Native mode uses the real Codex home, a fixed read-only sandbox and
mode-specific overrides; native shell reads of staged task documents are
allowed. It ignores host Codex user config, rules, custom MCP, plugins and
hooks. The sandbox limits writes, not access to every file the service account
can read; native mode is an explicit trust choice for that local read capability.
PR reviews using Codex receive
one invocation-scoped, read-only MCP endpoint. It supplies the complete file
manifest and final diff, plus related source and directory listings at pinned
head/base commits. Inline material is only a preview. GitHub credentials remain
in the parent service; the endpoint has no write operations and closes when the
invocation ends. Review proposals require complete manifest/diff reads and an
unchanged target. Codex requests bound to the same
PR or Issue restore their bound task session. In compatibility mode, the isolated invocation is
removed only after verified exit and successful session capture. An unarchived
session is retained across service restarts, including legacy invocations with
rollout files, and blocks fresh invocation with
`STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED`. Do not delete it to clear the
error: preserve the only copy of task history and investigate capture recovery.
MyDashboard also keeps durable task context in its own ledger and memory.

Native exec Review calls register the bundled `dih-pr-review` under the private
invocation's `.agents/skills` directory and invoke it explicitly with `$dih-pr-review`.
Automatic skill catalog instructions and bundled host skills are disabled for
that call; plugins, hooks and host MCP remain disabled. Only Review calls enable
native subagents, with the skill limiting independent reviewers to three and
requiring their results before completion. Non-Review calls keep subagents disabled.
Skill references are served by the existing read-only MCP, not host shell commands.
Complete reads of the native skill entry and its manifest are required alongside
the PR manifest/diff before a Review proposal can pass.

The package may read the installed `pr-review-tiering` policy and CE persona
documents from the service user's standard skill/plugin folders. It records content
hashes and missing optional resources in `review-skill/manifest.json`, without
pinning a plugin release or editing personal skills. The background adaptation
does not run CE's full Git/CLI/script/cross-model pipeline. Missing independent
results must appear as coverage limits, not a claim of completed deep review.
No skill receives publishing authority. Known staged skill files and their empty
parent directories are removed only after confirmed process exit; unknown residue
and native history remain preserved under the existing recovery rules.

For automatic own-PR review repair, a successful sealed `inspect` result on the
current bound Head is intermediate work: the original developer task is queued
again with its attested result. Ordinary/manual inspection keeps its existing
completion semantics. Failed, stale, unknown or superseded results do not advance
the repair. Inspect success alone is not evidence of code changes or publication.
Object preparation accepts validated mirror branch refs containing `#`; a missing
bound Head must be fetched by the trusted object synchronizer before creating the
code snapshot. Keep the failed job and audit trail when retrying the original task.

For a failed PR code proposal, the next role decision receives `code.failedExecution`
from the exact bound job and memory receipt: its safe failure code, visible action
statuses, and whether the observation history is complete. A matching local-owner
transition back to `queued` after that failure is included as `ownerRetry`, with a
bounded recovery note. This lets a developer distinguish a repaired preparation
fault from an unresolved code problem. A retry note grants no new permissions and
does not prove that code was changed or published. Old jobs, sessions and settled
proposal results remain intact; stale job or Head bindings are rejected.

When automatic own-PR repair is enabled, legacy PR patrol leaves authored
`address_review` items to the canonical developer route and supersedes its old
competing patrol jobs. Already emitted triage owner requests require separate
source reconciliation. A maintainer may replay a native `pull_request.observed`
event generated from a fresh complete successful GitHub snapshot through production
routing and ledger intake, after verifying the same current Head, feedback, actor,
generated-triage provenance and absence of live children/intents. Preserve the
original snapshot timestamp and audit history; ordinary manual owner requests are
not candidates for this repair.
The public routing input takes only event content (`schemaVersion`, `eventType`,
`occurredAt`, `source`, `subject`, `payload`) and recomputes its ID/digest; omit the
stored event's `eventId` and `contentDigest` when using `dryRun`/`ingest`.

With both GitHub actions and automatic own-PR repair enabled, developer role
cycles use the independent employee scheduler, as incoming Reviews do. They wait
for the latest successful fact refresh and retain maintenance admission,
cancellation and shutdown drain, without waiting for legacy patrol or optional
memory projection. Manual and scheduled requests for the same independent role
coalesce. Proposal execution, code jobs and publication still use their existing
controlled stages; a staged modify proposal is not evidence that code has run.

An already verified owner publication can recover internal review from its
unique committed delivery, original job and sealed evidence. This does not retry
an old rejected push. Missing proof is a pending review error. Retained completed
Review receipts can settle historical source bindings without another GitHub POST.
During managed shutdown, only typed, pure configuration-restart admission
rejections are drained as completed fences; mixed failures and unconfirmed
process shutdown still block restart.

Native Codex availability admission does not enqueue a redundant login probe
behind work already using the same native home. This keeps ordinary contention
from becoming a pre-claim resolution timeout. Actual generations remain serialized
and validate the home, session and CLI; cancelled, closed, blocked or unsupported
providers are still rejected. Busy admission does not certify a completed model call.

PR patrol can set `employees.prReviewer.primaryBrain` to a configured Codex
provider and exact model, with explicit requirements/code remote authorization
and `allowRemoteCodeContext`. Its existing `brain` remains the Ollama fallback.
Primary absence preserves old configurations. Only settled availability,
transport, deadline or output failures trigger one local fallback; cancellation,
authorization, source drift and unconfirmed stop/cleanup failures do not.
The job records the model actually used and a fallback reason, including failed
fallback attempts and later handoff failures. After a model change, healthy
matching PR facts can recover exhausted model-analysis failures once for the
new requested model, preserving the job/request key and cumulative attempts.
The per-model budget uses the requested primary even when the fallback fails;
restarts do not reset it. Paused, completed, confirmation-bearing and unknown
failures remain untouched. PR patrol still does triage; complete code Review
remains the PR engineer's responsibility.

Intent dispatch uses the active configuration's `workCoordination.leaseDurationMs`.
This differs from the role decision timeout and the proposal handler deadline.
If a proposal handler times out, inspect its downstream confirmation and code-job
receipt before diagnosing a failed repair: an idempotent in-flight handler may
complete after the retry was recorded. Do not create a second manual repair for
the same feedback solely because the outer wait timed out.
Automatic own-PR code preparation uses a handler budget derived from two
GitHub fact checks, one globally bounded Git preparation and the resolve budget,
with the ordinary 30-second minimum and a cap below the normalized lease. It uses
that matching lease so the result can still be persisted. Ordinary code proposals
retain their existing handler defaults. This changes waiting time, not authority.

Fixed-Head materialization reads Git blobs in batches of at most 128 unique
object IDs. Each command retains its configured timeout; all batches share the
total byte budget, and every object and protocol response is verified before
files are written. A measured #24723 recovery failure was a single 4,926-object
command timing out, not an output limit. Its same-Head probe passed after batching.
Keep the failed session and job as audit records; retry the original automatic
developer task only after verifying the fixed snapshot, current input binding,
absence of another active repair and an exclusive application writer lease.

The following capture and cleanup rules describe compatibility invocation
profiles. Native mode keeps conversations in the fixed Codex home and only
cleans its task-owned input/output workspace after verified process exit.

Invocation directories are temporary workspaces, not the permanent session
store. Normal completion removes them automatically after process exit, session
capture, and credential capture. A completed capture now writes a private
receipt. On a later invocation after restart, a dead owner's residue can be
removed only after verifying every retained session file against its saved copy
(an unchanged prefix is accepted when the saved history has newer turns).
Missing archives, changed history, live owners, and legacy residues without a
receipt remain intact for maintenance.

The cleanup byte budget distinguishes captured session files and staged review
artifacts (whose byte count is persisted in the invocation marker) from transient
SQLite, cache, and output files. Captured bytes use the existing 512 MiB session
storage limit; additional transient bytes remain bounded at 64 MiB. Unverified
directories receive no session allowance. Do not periodically delete the entire
runtime or permanent session store. Routine invocation cleanup is automatic;
retained failure evidence requires verified maintenance and must be preserved
before any manual recovery.

Internal attention state now writes schema version 2 and accepts version 1
without losing existing questions or answers. Startup and coordination cycles
archive pending questions only when the ledger proves their bound producer task
is cancelled, completed, or superseded. Archives retain the original question,
creation event, producer binding, retirement reason, and task revision; they do
not create answer outbox entries or requeue work. Temporary authority loss,
provider failure, and browser deferral are not retirement evidence. This is
logical archiving, not disk compaction: the bounded local audit history remains.
After the first schema 2 write, older versions of the attention inbox reader
cannot read the new state; use the preserved pre-upgrade data snapshot when
performing an intentional code and data rollback.
Code changes and test execution still use the controlled executor. GitHub
publishing, Assign and Unassign still use the existing action pipeline. Ordinary
actions require confirmation; explicitly enabled automatic Review and own-PR
repair use their activated policy without per-item prompts. Changing the Codex
login route grants none of these capabilities by itself.

Operational failures are deliberately stable and redacted:

- missing credential fails before binary discovery or process start;
- denied remote data fails before discovery or process start;
- missing or unsupported CLI reports Provider unavailable without exposing a
  candidate path;
- timeout, cancellation, output limit, invalid JSON/schema, or non-success exit
  terminates and reaps the process tree, then ends the one attempt;
- an unprovable process-tree reap or temporary-directory cleanup fails closed
  and retains evidence instead of starting another invocation.

Correct the credential, version, authorization, or capacity problem and let a
new trusted work revision be scheduled; do not manually retry external effects.
Vendor calls may incur usage charges even though MyDashboard itself runs
locally. Review vendor billing, retention, region, and training settings before
resuming a role.

### Native Codex migration and rollback

Native mode is opt-in. An upgrade, opening the configuration page, or adding a
new provider does not silently convert an existing provider. The Codex template
and example configuration retain `codex-login`; a missing mode stays `api-key`.
Claude rejects `codex-native-login`.

1. Record the currently active configuration version and create a verified
   MyDashboard backup. Preserve existing private task-session archives and any
   retained failure evidence. Separately back up the native Codex home according
   to the CLI's storage requirements and the app's native session references at
   `<temporaryRoot>-native/sessions`. Managed startup normally places this at
   `<privateRuntimeDirectory>/supervised-cli-v1-native/sessions`; standalone
   construction defaults to `.mydashboard-supervised-cli-v1-native/sessions`
   under the service user's home. Both are private state outside MyDashboard's
   data backup manifest.
2. Under the exact operating-system account that runs the managed service,
   verify the official Codex CLI is installed and its login works. If using
   `CODEX_HOME`, set the intended absolute home before starting the service;
   changing it later in a browser or configuration document is unsupported.
   Use the managed private runtime directory: its parent must pass the existing
   owner/ACL checks. A general-purpose Windows TEMP or profile directory can
   have extra write permissions and fail those checks before Codex starts.
   Diagnose the runtime-directory preparation phase before reinstalling or
   logging in again; never repair this by weakening the native home's ACL or
   deleting its history.
3. In **配置中心 → 大脑 Provider**, select **Codex 原生登录（会话由 CLI 保存）**
   for one intended Codex provider. Keep its model, role assignments and
   `remoteData` permissions explicit. Save, validate, inspect the impact, and
   confirm activation. Use the managed `Restart` command after activation.
4. Check the selected-mode readiness, then observe a bounded intended role task.
   Verify its CLI start, structured result, session reference and ledger receipt.
   For automatic Review, also verify the exact Head, published Review and
   subsequent handoff. A web HTTP 200 or readiness `available` alone is
   insufficient acceptance evidence.

An existing archived compatibility conversation is not automatically imported
into native mode. Its history remains available for maintenance; the new route
creates its own entity-bound native conversation. Do not attempt a migration by
copying an entire old invocation profile into the native home. Separate native
  invocations sharing the home use bounded service admission. Capacity defaults
  to one; `brainProviders.<id>.maxConcurrentTurns` may be raised to 2–4 after real
  Windows concurrency, authentication and process-cleanup validation. All native
  providers sharing the home must use the same capacity. Different entities may
  overlap while one entity and login probes remain serialized; avoid concurrent
manual edits to that home during maintenance.

To roll back, pause the affected role, allow supervised work to settle, select
the previous credential mode in a new configuration version (or activate the
previous version), confirm and perform a managed restart. Keep both sets of
history and session references. Recheck execution and reconcile any `unknown`
GitHub result before resuming; changing modes must not replay an external effect.

**Never include the native Codex home in task-temp cleanup.** The task directory
holds expendable staged documents and output; the Codex home holds login and
conversation history that may be the only recoverable copy. The native runtime's
`sessions/` directory holds persistent references, so do not delete the entire
`<temporaryRoot>-native` root as temporary garbage either. MyDashboard does not
archive or rotate native CLI history. Any intentional CLI history
retention change requires separate verified backup and a stopped or settled
writer. Do not clear a session error by deleting either history store.

Native session references use a small `.json.pending` journal written before
launch. A journal with a known thread ID resumes that exact conversation if
final reference publication failed. An unknown ID blocks only that entity;
unrelated tasks can continue after the prior process is confirmed stopped.
When the supervised runner proves that it never attempted to spawn a process,
the service removes that invocation's pending journal so the same entity can
retry. A public error code or user-supplied flag is not such proof.
Preserve the journal and native history. Maintenance must identify the correct
native thread and publish its reference using `CodexNativeSessionStore.save`
with the exact router-bound session key. Do not remove a pending journal merely
to make retry succeed: that could silently start a new conversation.

Native structured results normalize literal LF, CR and TAB characters only
inside the inner JSON's strings. The outer envelope, duplicate decoded
keys, other syntax, dangerous keys and resource limits remain strict. This
preserves multiline text without inferring missing JSON structure.

Automatic own-PR graph tasks whose post-code decision exhausted on an invalid
native result may receive one fresh decision after this parser upgrade. The
system requires matching failed-attempt history, a completed app-server turn,
the exact task revision and lease, current PR authority and no owner hold. It
records `native_result_string_format_retried`, retains lifetime attempts, and
does not replay the old response or mark any deliverable complete.

Codex PR review JSON traces can contain tool-read output. Their stdout transport
budget is 64 MiB, separate from the configured structured final-response limit
(at most 1 MiB). This is not a per-source-file or total-diff truncation rule;
the read-only MCP reader supplies complete paginated documents. Exceeding the
trace transport budget stops the invocation with an output-limit error rather
than accepting an incomplete review.

## GitHub CLI login credentials

GitHub writes remain disabled until both the action type and its exact queued
item are enabled and confirmed. The recommended `credentialMode: "gh-login"`
uses the current GitHub CLI login of the same operating-system user that runs
MyDashboard. Install an admitted `gh.exe` at a fixed absolute path, then log in
as that user without involving MyDashboard:

```powershell
gh auth login --hostname github.com
```

In **配置**, choose **GitHub CLI 当前登录（推荐）**, set the exact
`actorAccountId` and fixed `ghCommand`, enable only the required actions, then
validate, inspect, and confirm the version one item at a time. Restart only
after the activated version reports that a restart is required. Do not set
`GH_CONFIG_DIR` for the managed service and do not copy a host `hosts.yml` into
the project or application data.

At an authorized execution or reconciliation boundary, MyDashboard supervises
the equivalent of `gh auth token --hostname github.com --user
<actorAccountId>` in a private temporary working directory and validates the
bounded token output. The selected GitHub transport then uses that lease to run
`GET /user` and verifies the exact `actorAccountId` before any write or other
mutation. The token lives only in a short in-memory lease; it is not persisted
or shown, and cleanup releases all retained references before another action
can acquire the source. Every Review, comment, update branch, push, or merge
still requires its individual confirmation or an applicable activated automatic
workflow policy; selecting `gh-login` grants no action by
itself.

For compatibility, `credentialMode: "token-env"` reads only the environment
variable named by `tokenEnv`. Use a dedicated minimum-permission token and
restart the managed service after changing its environment. There is no silent
migration or fallback between `gh-login` and `token-env`.

Missing login, unavailable or replaced CLI, account mismatch, timeout,
oversized or malformed output, and temporary-directory cleanup failure all
fail before a GitHub write. Correct the same-user CLI login or activated
configuration, then let the durable queue retry only when its state permits.
If an already-started external result is `unknown`, do not click repeatedly or
run `gh` manually; reconciliation must resolve that receipt before duplicates
are unblocked.

## Runtime status

Open the **系统** view to inspect:

- liveness and readiness;
- the maintenance gate and in-flight operation count;
- recovery blockers and external actions with unknown results;
- storage-capacity and probe warnings;
- the verified backup catalog.

The safe read endpoint is `GET /api/system/status`. `GET /api/live` remains a
minimal liveness check even when readiness probes fail. A live process is not
necessarily ready: do not resume employees or retry external actions until the
readiness blockers are understood.

## Owner work intake

Use **工作流 → 创建共享工作** to put a new owner request into the shared task
graph. The target is server-controlled: the request first enters the
orchestrator and cannot name a role, node, permission, or internal identifier.
If submission reports a transient failure, retry the unchanged form; the page
reuses its request ID and the service reconciles any routing or ledger write
that may already have completed. A successful response can be read through
`GET /api/work/requests/<request-id>` and the resulting assignment and work item
through the existing workflow and ledger views.

The durable state is stored under the active data directory as
`owner-work-requests-v1`. It participates in normal consistent backups. A
digest or audit-chain mismatch fails the intake runtime closed; preserve the
state and restore a verified backup rather than editing the file manually.

## Create a consistent backup

Use **系统 → 创建备份** while the service is running. The server first checks
directory metadata without reading payloads or closing write admission. An
oversized source is rejected at this stage. This is an early rejection only:
concurrent writers can change the source, so the server discards the preflight
facts, closes global write admission, waits for admitted HTTP and background
work to drain, captures a checkpoint of every declared durable store and file, copies and hashes the
payload, verifies the published backup, and then reopens admission. New writes
receive HTTP 503 while the maintenance gate is closing or closed. A failed
backup also reopens the gate in `finally`.

The limits remain 100,000 files, 100,000 directories, depth 128, 4 GiB per file,
256 MiB per root JSON store, 64 GiB total file bytes and a 16 MiB manifest.
Passing metadata preflight does not promise that content, store validation or
the manifest budget will pass. Metadata and content are checked again under
the maintenance gate, and source integrity is checked again before release.
Closing the browser or timing out its HTTP request does not cancel the backup.
Backup failures are logged independently of that observer as bounded JSON
containing allowlisted codes, a stage and optional numeric counts; raw error
messages, paths, credentials and payloads are not included.

The replaceable `data/playwright-browsers/` and
`data/validation-profile-probe/` validation caches are explicitly outside the
durable checkpoint and can be recreated with `npm run setup:validation-browser`.
Every other StateStore JSON value, including legacy array-valued stores, is
hashed into the checkpoint; values without a revision envelope use revision
`0` plus their content digest. Undeclared hidden paths and aliases still fail
the scan closed instead of being silently omitted. Source dotfiles are supported
inside declared executor workspace copies, Windows test workspace/resource
copies and the exact generated Docker test-library layout. Hidden files outside
those namespaces, traversal, aliases, links and Windows device/stream paths are
still rejected. Root archive stores share the existing file-count ceiling and
the combined 16 MiB manifest budget.

The equivalent same-origin browser contract is:

```http
POST /api/system/backups
Content-Type: application/json
X-MyDashboard-Action: 1

{}
```

A successful response contains a content-addressed identifier such as
`backup-<64 lowercase hex>`. Backups are stored in the ignored `backups/`
directory. An item appears in the status catalog only after manifest and
payload verification. Status polling reads the bounded atomic catalog and does
not hash every retained payload. Its status is therefore the result of the last
deep verification; an explicit verify or restore refreshes an item to
`verified` or `corrupted`. Legacy directories without a catalog record appear
as `unindexed` until explicitly verified. Incomplete, unrecognized, missing,
or corrupted entries remain visible rather than being silently accepted.

Keep independent copies according to your retention policy. MyDashboard does
not currently delete old verified backups automatically, and deleting active
data does not delete backups.

If the complete source exceeds these limits, the current managed backup and
restore format cannot represent it. Executor workspaces, Windows test resources,
generated test-library files and durable artifacts are counted; their names do
not authorize deleting or excluding them. The two declared validation caches
above are already excluded. A managed lifecycle recovery snapshot preserves
managed components in place and is not a complete independent backup.

Keep the deployment blocked until a complete recovery point exists. An operator
can separately authorize a consistent filesystem or volume backup to trusted
external storage, after measuring the complete source and available destination
space. Such a copy requires either a verified stopped writer or an approved
consistent snapshot of every participating volume, preservation of all durable
components and recovery configuration, and an isolated restore verification.
It is a separate recovery procedure, not an input accepted by the current
managed restore API. Do not assume a nearly full source volume has room for the
copy. Expanding the managed format instead requires a coordinated change to
checkpoint, manifest, payload verification and restore limits with capacity and
restore tests; changing one constant or excluding unclassified state is unsafe.

## Restore a verified backup

Restore is deliberately offline. First copy the required backup to trusted
storage if needed, then stop the exact managed service and confirm its status:

```powershell
.\scripts\Manage-MyDashboard.ps1 -Action Stop
.\scripts\Manage-MyDashboard.ps1 -Action Status
.\scripts\Manage-MyDashboard.ps1 -Action Restore -BackupId backup-<64-hex>
```

The restore command refuses to run if the manager has a live process, retained
unknown process state, or any listener on the configured port. It validates the
backup into a separate candidate directory, runs migration and read-only
reconciliation, records a durable swap journal, atomically activates the
candidate, and retains the previous active directory until the activation
receipt is durable. The service remains stopped after success; inspect the
receipt message, then start it explicitly:

```powershell
.\scripts\Manage-MyDashboard.ps1 -Action Start
```

`Start` and `Restart` automatically recover an interrupted swap when the
ignored `restore-control/` transaction directory exists. Repeating the same
successful restore is idempotent. Do not manually rename `data/`, edit files in
`restore-control/`, or remove candidate/rollback directories during recovery.
If recovery cannot prove one safe state, it fails closed and leaves the evidence
for diagnosis.

Graceful shutdown aborts cooperative background I/O and has a bounded drain
deadline. If work or a runtime does not drain, the manager writes an
authenticated failure receipt and retains both its control state and the global
writer lease. It does not report a successful stop or begin offline restore in
that uncertain state.

## Incident procedure

1. Stop new employee activity in the UI when it is still reachable.
2. Run `Status`; record its exact output and the time.
3. Read the **系统** readiness blockers and unknown external-action kinds.
4. Preserve `server.log`, its bounded archives, `restore-control/`, and the
   relevant content-addressed artifacts. Never post them publicly without
   sanitizing credentials, source, messages, and personal data.
5. For an unknown GitHub mutation, use the system's read-only reconciliation;
   do not manually retry the mutation.
6. For an interrupted restore, run `Start` so the manager performs offline
   recovery before launching the server. If it still refuses, preserve the
   state and investigate instead of deleting the journal.
7. After repair, require a ready system status and run the relevant focused
   tests before resuming roles or privileged actions.

## Capacity and maintenance

The readiness service warns when the active data volume reaches 80% usage and
marks it critical only when usage reaches 95% and available space falls below
10 GiB. A large volume with ample remaining space stays ready with a warning.
Make space using normal operating-system tools only
after resolving exact paths. Do not recursively delete a computed project,
home, runtime, data, backup, or restore directory. Prefer moving an old verified
backup to separate trusted storage, verify the copy, and only then remove the
exact original by its full path.

Run `npm test` after upgrades. Configuration replacement and schema migration
must complete before employees are resumed. Privileged settings remain disabled
in `config.example.json`; review every enabled role, brain data class, workspace,
GitHub action, and routing rule in the active version after an upgrade.

## Automatic authority and execution capacity

With automatic Review or own-PR repair enabled, routine grants for current,
trusted owner-requested local work are approved by the system after checking
its live Head/Base, task, role, workspace and execution binding. Draft status
alone does not prevent local inspection or verification. Automatic Review
uses the current assignee list; old assignment timestamps and pending CI do
not require another confirmation. A removed assignee, a same-Head published
Review, explicit task pauses and rejected proposals remain authoritative.

Automatic coordination can delegate subsequent configured capabilities and
replace cancelled children without a one-child historical limit. It preserves
paused children rather than replacing their work. An authority-rejected root
yields the next cycle of its role, so other roles cannot accidentally consume
that deferral and let it monopolize the queue again.

The controlled executor's session limit counts active, interrupted or
cleanup-pending sessions. Completed, failed and cancelled history without a
cleanup fence remains readable and does not consume execution capacity.

Existing local code proposals are also polled on the 10-second automatic
continuation tick after fresh facts are admitted. This uses the same leased
proposal runner as ordinary coordination and coalesces concurrent polls, so
pending authorization retries do not wait behind a native code model run.
The independent poll participates in operational admission and shutdown drain.

Automatic own-PR code execution also uses a separate coalesced 10-second poll
after facts are admitted. It reuses the controlled worker and configured batch
limit, with at most two jobs executing concurrently. Each poll only schedules
work: a free execution slot can accept a newly queued job while another job is
still running. Each admitted job has its own worker and abort signal; the shared
session transition lease, authority checks and persisted job revisions still apply.
Housekeeping can reconcile
results, publish completed repairs and refresh PR facts while another model runs.
The `codeJobExecution.runCycle` drain participant retains ownership until every
admitted operation actually settles; maintenance and shutdown still fence work.

Automatic agency cycles, including the legacy PR patrol and requirements role,
have their own coalesced execution lifetimes. Fact refresh completes after source
intake and confirmation reconciliation; it does not wait for model or memory
projection work. Roles recheck admitted facts before entering and wait again if
a refresh starts during admission. Cancelled fact waiters release their slot;
already admitted work remains owned until it settles. Manual mode keeps its
ordered background queue.

An initial specialist context timeout or typed unavailable PR-facts response
schedules the same durable infrastructure retry without using a model-work slot.
The cycle can then admit another ready task, even with `workLimit: 1`. Availability
checks and claims remain bounded; an error after the model started or an untyped
lookalike still consumes its normal work slot.

With automatic own-PR repair and coordination enabled, a complete fresh GitHub
snapshot also checks authored PR responsibility changes from developer to tester.
An inactive tester root requires its retained trusted Head lineage, the current
approved route, a fresh account/author/assignee/Head/Base observation, and a proof
sealed to all subject-root revisions. Intake applies this host-only handoff before
ordinary metadata from the same snapshot. It settles the target's old scope and
uses the existing cross-root cutover to retire the old developer; sealed unknown
effects keep the handoff blocked until normal reconciliation can settle them.
Public events cannot create a handoff, stale proofs are ignored, and explicit
owner controls and independent owner/internal-review authority remain in force.

An unbound code proposal whose operation cannot produce any contracted
deliverable now reports `delivery-evidence-incompatible`. The graph can also
explain an exact historical `policy-binding-invalid` failure after recomputing
the same incompatibility from its current input and unchanged contract. This
read-only diagnostic reaches the queued parent orchestrator; it does not replay
the proposal, reset the child, replace a change-package with a test-report, or
discard prior successful package evidence. The parent must arrange compatible
work and require the actual repaired snapshot for verification.

Structured local-owner `fix_ci` requests can enter the same CI repair pipeline
after the ledger verifies their current owner root and fresh GitHub observations
prove the configured actor is the PR author at the exact Head/Base with failed
checks. The event need not claim `relation: authored`. Missing evidence defers
the repair instead of creating another generic modify job. Existing source-null
jobs/packages remain unchanged. Developer duplication is suppressed while the
repair runs or its original Head is consumed; the orchestrator can still settle
children, and normal local completion does not interrupt an authorized push.

## Automatic work continuations

In automatic mode, schema 2 of `work-continuations.json` records the source task,
next role, trigger condition, input revision, retry action, and up to five wake
receipts per task. Waiting external results, facts, dependencies, and manual
resumes remain visible without authorizing execution. Schema 1 migrates without
inventing past execution receipts. Fresh intake and completed
role runs signal the scheduler; a 10-second scan recovers missed signals. Each
role still uses its normal claim, permission, current-input, and pause checks.

Wake intent is saved before dispatch. Interrupted wakes are recovered after a
restart; repeated signals for an active role share its existing execution.
The ledger remains authoritative, so a crash before the wake record is saved
is recovered from claimable work. This is recoverable delivery, not an atomic
transaction between the ledger and wake store.

Three attempts without progress produce a stalled diagnostic and a five-minute
retry interval. They do not block the ledger or disable the existing role timers.
The execution deadline reuses the configured claim, context, and decision budgets.
An overdue wake persists a stop request and aborts its owned execution signal;
its active slot and shutdown admission remain held until the real work settles.
Recovery continues when fact refresh fails; new dispatch still waits for fresh
facts. Ready work can replace closed waiting diagnostics when the bounded wake
store is full, while open execution receipts remain protected.
An already running role shared through coalescing keeps its original ownership.
`GET /api/health` includes bounded handoff records, overdue counts, and stalled-work details.
Backup and restore validate the continuation store alongside other state owners.

Initial context-assembly timeouts schedule a delayed retry without consuming a
model decision attempt. Errors after a model has started retain the existing
decision budget. Historical assignment requests display their dates and do not
represent all automatic assignments.

The optional [BullMQ experiment](../experiments/bullmq-continuations/README.md)
exercises restart durability, active-job deduplication, backoff, worker loss,
role isolation, and an idempotent synthetic effect after a lost acknowledgement.
It uses an isolated private package and a disposable loopback Redis container;
the production scheduler does not depend on BullMQ or Redis.

## Live GitHub smoke-test cleanup

Any test that creates a real GitHub pull request must register cleanup as soon
as the PR exists and run verification through `withSmokePullRequestCleanup` from
`scripts/github-smoke-pr-lifecycle.mjs`. The wrapper runs cleanup after both a
successful assertion and a failed or interrupted verification path.

Cleanup is intentionally narrow: it accepts only PRs owned by the authenticated
account whose title begins with `[MyDashboard E2E]`, contains `DO NOT MERGE`,
and whose same-repository head branch begins with
`test/mydashboard-e2e-`. Ordinary PRs, forks, and product branches are refused.
To reconcile an orphaned smoke PR explicitly, run:

```powershell
npm run cleanup:e2e-pr -- --repo owner/repository --pr 12345
```
