# Architecture

Development Intelligence Hub is a single-user, local-first command center. It combines observed
engineering signals with durable work, autonomous role decisions, controlled
execution, explicit human decisions, cited memory, and recoverable operations.

## Runtime shape

```text
GitHub / DingTalk / local imports
              |
        read-only adapters
              |
      facts and immutable events
              |
   workflow router -> work ledger/graph -> role employees
                               |               |
                               |          brain router
                               |   (Ollama, HTTPS, or CLI)
                               |               |
                               +---- validated intents
                                         |
                                  policy + dispatcher
                                    /           \
                         authorized execution local waiting,
                          /             \      handoff, memory
                 controlled code     GitHub actions
                         \             /
                    evidence and receipts
                              |
                    memory projection/search
```

The composition root creates services and passes frozen, least-authority ports
between them. Domain modules validate bounded records; services own state
transitions; adapters isolate operating-system and remote side effects; the
server exposes safe projections rather than underlying stores.

## Durable control plane

Workflow events are routed into a persistent work ledger. Each role claims work
under a lease, assembles evidence-bound context, asks its configured brain for
one structured decision, validates that decision, and emits an intent. Policy
maps the intent to the exact authority permitted for that role and work item.
The dispatcher then records the result or hands it to a narrower execution
boundary.

The orchestrator, requirements analyst, PR engineer, developer, and tester are
independent roles. Their schedules, pause states, permissions, routine brains,
and task brains are configurable. Replacing a brain changes reasoning quality,
not authority.

### State and recovery ownership

The work ledger owns business state, input bindings, leases and deliveries. A
task-run receipt describes one invocation; a completed invocation does not prove
that its business task is complete. Continuations own wake times and backoff,
while the graph and user interface project these records without granting
execution authority.

Recovery policy is defined independently of display text. Work-item decisions
and controlled code jobs intentionally use different policies for process exits
and session failures. Review readers retain trusted source-failure identity
across the provider boundary; unreadable source material and unclassified
request failures consume the ordinary bounded decision budget. They cannot
become provider outages simply because a transport adapter lacks their code.

New host maintenance questions carry a validated outbox recovery stamp bound to
the task, input, intent and source. Model JSON cannot create the live host
capability. New ordinary records have an explicit null marker; historical absent
markers retain an isolated legacy reader. Both ordinary staging and graph
escalation use the same failed-intent rearm boundary, which preserves ordinary
historical retries without transferring maintenance origin. Inbox and browser
projections use derived machine codes, so changing localized wording cannot
change retry behavior. Existing source, lease, approval and delivery checks
remain authoritative.

### Supervised CLI brain boundary

Codex CLI and Claude CLI are remote reasoning providers behind the same brain
router and data-class admission gate as HTTPS providers. The trusted controller
remains deterministic MyDashboard code. For each admitted task revision it
locates an admitted official Windows x64 npm binary, creates a private
invocation directory, and automatically starts one supervised child-process
tree with task input on stdin. The task ledger, source binding, cancellation,
timeout and result validation belong to the service. Claude uses only its fixed
API-key environment variable. Codex supports three explicit modes: `api-key`,
brokered `codex-login`, and `codex-native-login`. A missing mode remains API-key;
no mode silently falls back to another.

The compatibility `codex-login` broker derives the source only from startup `CODEX_HOME` or the
current Windows user's default Codex directory. It handle-validates the one
file login source, synchronizes an atomic private mirror outside project/data/
backup roots, and stages only the authentication file into the disposable
profile. It never mounts the full host profile or writes back to the host login
source. All login-mode providers for one service user share a FIFO lease across
source synchronization, the model process, refreshed-credential capture, and
cleanup. Login, account switch, and logout changes are therefore observed only
at a task boundary without concurrent refresh overwrite.

The compatibility and API-key routes use disposable profiles and an
empty-origin environment, excluding inherited host Git/GitHub/SSH credentials.
Codex task conversations are captured into the private task-session store and
restored for the same bound entity. Capture or cleanup failures retain evidence
and stop unsafe reuse. The private credential mirror is not part of backup,
restore, packaging, or open-source distribution.

The opt-in `codex-native-login` route passes the service account's startup
`CODEX_HOME`, or its default Codex home, directly to Codex. Codex owns native
authentication refresh and conversation files. MyDashboard neither stages auth
bytes nor creates a credential mirror, and does not copy session directories.
It persists only the task/entity-to-session reference, resumes that session for
the same entity, and serializes native invocations sharing the home. Native
conversation history is external private runtime state, not disposable task
output. Existing compatibility archives remain preserved; there is no automatic
history migration when changing modes.

Native session references are stored under `<temporaryRoot>-native/sessions`.
Managed startup normally uses
`<privateRuntimeDirectory>/supervised-cli-v1-native/sessions`; standalone
construction defaults to the service user's
`.mydashboard-supervised-cli-v1-native/sessions`.
Despite the runtime-root naming, this subdirectory is durable application-owned
private state. It contains the native-home digest and thread ID, not transcripts
or credentials; it is outside the project data backup and must be preserved
alongside the native home for disaster recovery.

Codex PR review invocations receive a scoped read-only MCP reader for the
complete change manifest, final diff, and related source at immutable head/base
commits. The MCP endpoint has no writes and retains GitHub credentials in the
service. The App Server route disables shell tools and verifies its scoped MCP
inventory; the compatibility exec route can use read-only shell tools for staged
task documents. Inline previews are bounded; complete change-set reading is a
separate enforced evidence condition. Neither native mode nor the MCP reader
grants direct GitHub publishing authority.

Native exec reviews advertise `supportsNativeReviewSkills`; the role engine
references the registered skill instead of embedding the legacy quick-review body.
The provider stages a fixed `dih-pr-review` entry, explicitly invokes it, and serves
its content-fingerprinted references through the scoped reader. Native agent tools
are enabled only for these Review calls. Its tiered background procedure reuses
available installed routing/persona documents, preserves the business decision
schema, and records actual coverage; it is not the unmodified CE workflow.

The native read-only sandbox restricts writes, not read confidentiality across
the service account's filesystem. Native mode therefore trusts Codex's local
read capability for that account. The compatibility exec transport uses
ignore-config/rules flags. App Server instead verifies effective capability
settings, disables inherited MCP registrations, and verifies the invocation's
scoped tool inventory. Shell tools, plugins, hooks and apps are disabled.
Personal `AGENTS.md` can still supply guidance on the App Server route; it is not
execution authority. No original configuration is edited. A sanitized environment
and read-only sandbox do not isolate all host-readable files or on-disk
credentials. See the transport-specific [operations notes](OPERATIONS.md#running-task-controls-and-optional-codex-app-server).

The vendor strategies use fixed mode-specific sandbox flags and accept only
bounded, strict structured output. Output is untrusted: it returns to the existing
decision schema, policy, ledger, memory, controlled-code, and confirmation
boundaries. It cannot directly mutate a repository or GitHub. A timeout,
cancellation, malformed result, output overflow, unavailable binary, or process
reaping failure ends that attempt; the role does not ask the CLI to repair its
own response. Cross-task coordination belongs to MyDashboard's durable ledger
and memory, while same-entity conversations follow the selected mode's session
storage. Native App Server code jobs now execute several controlled tools within
one turn; code jobs retain the controlled executor for every code/test action.

The continuous code route carries a process-private `codeExecutionContext`
through versioned authority, the brain directory and router. Its temporary MCP
endpoint exposes only `perform_action`, `read_source`, and `get_state`. The worker
reloads job/session state and grant authority, binds trusted fields, prepares and
admits each action, verifies its audit result, and records its durable observation.
Tool requests serialize; repeated mutation request IDs reuse a receipt and
conflicting payloads are rejected. Endpoint receipts live only for that invocation;
crash recovery remains the durable action reconciliation protocol.

Source pages bind a current audited read action and workspace revision. Full-read
proofs are committed before an overwrite; writes revoke old revision proofs.
Current source metadata remains available after resume even when initial inline
observations have been compacted. Final `complete` is admitted only after native
process exit, tool drain, current required profiles and complete reads. A short
task-control completion fence checks durable owner instructions before closing
instruction acceptance. Undelivered requirements defer completion to the next
scheduling turn without replaying audited actions; late instructions receive an
explicit conflict. Asynchronous grant verification is followed by another stop
check before action admission. The native
turn has a 15-minute minimum budget or the longer configured provider timeout;
the existing action budget remains enforced. Other providers keep one-action
decisions. No configuration or native-history migration is performed.

Owner-created work enters through a separate structured command-center
contract. The browser supplies business content only; role, node, permission,
event, assignment, and work-item identities are server-owned. A reserved
highest-priority routing rule sends this event to the orchestrator before any
ordinary configured rule can match it. The intake service durably stages the
request, binds its workflow assignment, and then binds the corresponding ledger
item. Each transition is content-addressed and restart recovery reconciles a
lost routing or ledger response instead of creating a second root task.

### Running tasks and owner adjustments

`TaskRunRegistry` observes role model calls and controlled code actions through
process-private async context. Its HTTP projection separates actual active
operations from queued work. Controls bind both a run UUID and a durable settings
revision; settings cannot grant executor or GitHub authority. Supplemental user
messages are supplied on the same task's next model turn. A changed instruction
discards an old decision at its checkpoint; an already performed code action is
never repeated merely because requirements changed.

Pause/cancel holds precede retry dispatch and survive restart. Ledger settlement
uses the original claim, existing code-job controls and graph cancellation.
Unconfirmed native process stops require positive recovery evidence; code-job
terminal states win late controls. Scheduled coordination performs reconciliation,
whereas list/detail reads do not mutate the task ledger.

Windows native login uses the contained App Server transport by default and
binds steering/interruption to the exact native thread/turn. A continuous code
turn owns one task-run record for both reasoning and executor actions. Persisted
stop controls close subsequent action admission; native exit and host-action
settlement must both be proved before the stop is confirmed. Unknown results keep
their existing fences. Protocol and synthetic-process checks are separate from
production activation and real PR acceptance. See
[operations](OPERATIONS.md#running-task-controls-and-optional-codex-app-server).

## Confirmation and side effects

Native model admission reserves bounded capacity before claiming role work.
Capacity waits do not consume model execution time or work attempts; different
entities may use explicitly validated capacity while one entity remains serial.
The admission key identifies the PR independently of its authorization session,
so role preclaims and direct code-job calls cannot run that PR concurrently.
Task execution receipts persist bounded phase, activity, native session and stop
metadata without conversation or progress bodies. Open receipts recover as
unknown after restart; metadata is not proof that a process has stopped.
Failed receipt writes retain their bounded pending batch for the next operation;
versioned updates and durable rereads prevent an uncertain acknowledgement from
overwriting newer observations. Corrupt persisted state fails closed.

Completed repair publication records a deterministic internal review delivery in
the same durable update. Recovery submits that delivery without replaying push.
The internal source binds publication, controlled commit and current Head and
routes to the PR engineer. Developer reports remain unverified inputs, and the
policy rejects external GitHub actions from internal review.
Before repair, the service captures the complete original review feedback with
its digest and original Head. Internal review reads that immutable snapshot and
the repaired diff through the private paginated reader; native and supervised
Codex terminal decisions require complete reads. Snapshots are immutable archive
records; hot repair/publication rows retain digest-bound references. Archive
readback precedes the hot-state update, so uncertain writes preserve the old
inline copy. Schema 1 remains readable and restore validates every referenced
archive before writing any migration. The reader works when repair automation is off.

Historical owner publications use a separate observed-publication provenance,
not a synthetic completed confirmation. A read-only committed-delivery lookup
verifies the original job, sealed evidence and receipt before creating the same
durable internal review delivery. Missing or ambiguous proof remains pending.

Delivered Head-bound fact waits can be superseded when newer PR code arrives;
explicit time waits and unknown side effects remain fenced. Lost Review
references recover only an exactly bound historical confirmation. Completed
receipts can settle a previously misclassified stale root without republishing
the Review or changing its recorded history.
Decision attempt budgets restart only when a proven Head actually becomes active,
while the lifetime claim counter remains intact. The active source durably binds
the offset to its activation and previous active revision; accepted pending Heads
do not consume or replace it. Legacy offsets require retained activation and a
side-effect-free timeline, then are sealed by a normal atomic claim. Automatic
recovery of older false exhaustion still requires that timeline proof. Ignored scope
reentries retain audit observations without mutating inactive terminal roots or
blocking intake of later valid source facts.

Human-only operations enter one durable confirmation queue. A request is bound
to its revision, digest, actor, source provenance, and target identity. The UI
shows one request at a time and cannot replace server-owned payloads. Stale or
revoked requests fail closed.

Code work uses fixed semantic actions in isolated workspaces. The code executor
does not grant an arbitrary host shell; native brain reads run under its separate
read-only sandbox. Applying a change package, publishing a commit, and GitHub
mutations have separate authority checks. Ordinary actions require individual
confirmation. Explicit `automaticReview`, `assignAfterAutomaticReview` and
`automaticOwnPrRepair` settings permit the corresponding bounded workflows
without individual prompts; they do not authorize automatic merge or Issue
closure. Git operations bind the observing account, base and
head repositories, refs, and object IDs. A changed binding invalidates derived
work.

External actions use intent, policy, dispatcher, durable receipt, and
reconciliation stages. If the process cannot prove whether a call completed,
the result becomes `unknown`; duplicate execution remains blocked until a
trusted observation resolves it.

GitHub mutations select one credential source only after authority and the
current individual confirmation or activated automatic policy have been
revalidated. The compatibility source,
`credentialMode: "token-env"`, resolves the configured environment-variable
name. The recommended `credentialMode: "gh-login"` source supervises a fixed
absolute GitHub CLI binary in a private temporary working directory and asks
the same operating-system user's current login for the exact
`actorAccountId`. Browser data cannot supply a command, profile path,
`GH_CONFIG_DIR`, token, hostname, or account override. Account mismatch,
timeout, malformed output, or cleanup failure occurs before the transport can
write.

The legacy GitHub action adapter and the PR external-action transport share
this credential-source boundary and the same confirmation executor. A bounded
credential lease exists only for authorized execution or reconciliation, is
passed directly to the selected transport, and releases its references during
cleanup. No credential enters intent state, receipts, logs, browser responses,
model context, backup, or recovery data. Credential selection never changes
the immutable account, repository, ref, Head OID, action, or payload binding.

## Memory

Raw local records are authoritative. Search and cited answering select bounded
records from the local index. A generated answer is accepted only when each
claim cites currently accessible raw evidence; derived or superseded records
cannot be the sole authority. Local inference works without a remote provider.
Remote inference additionally passes the per-data-class authorization gate.
Roles receive memory only through an explicit `query_memory` intent. The query
is durably reserved before inference, limited to one attempt per work revision,
revalidated against current citations, and then returned to the same role
decision; replacing the brain does not grant memory access or side effects.

## Operations and recovery

Mutable stores use single-writer queues, revisions, digests, journals, or
content-addressed artifacts. Startup restores state and reconciles uncertain
operations before readiness. Backup closes admission, drains participating
writers, records a global checkpoint, then copies and hashes the declared data
set. Restore validates into a separate directory, migrates and reconciles it,
and activates it only after those checks pass.

The startup bootstrap captures a private source checkpoint before importing
the application. The public runtime identity contains the commit, tree, and
declared-package digest; the process-private checkpoint also binds the Git HEAD
reflog. Rechecking both after module loading detects edits and ordinary
commit/checkout/reset A-to-B-to-A races without exposing local history through
the status API. It is a provenance boundary, not protection from another
process already running as the same trusted local user.

Liveness answers only whether the local process can serve. Readiness also
accounts for store health, reconciliation blockers, recovery state, and
capacity. See [OPERATIONS.md](OPERATIONS.md) for procedures.

## Trust boundaries

- The loopback process and its local operating-system account form the primary
  trust boundary.
- Browser payloads, model output, repository content, imported text, remote
  responses, and recovery inputs are untrusted.
- Secrets are injected from environment variables into the smallest possible
  adapter and must not enter model context, state, logs, or browser responses.
- Privileged features require explicit activation. Automatic workflow settings
  replace per-item prompts only for their declared scope; current source,
  authority, evidence and unknown-outcome checks still apply.
- GitHub writes remain fake or disabled in ordinary tests and local acceptance
  unless the owner has separately confirmed the publishing account.
