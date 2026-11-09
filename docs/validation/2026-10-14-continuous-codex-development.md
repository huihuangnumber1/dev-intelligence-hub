# Continuous Codex development validation — 2026-10-14

## Implemented behavior

Native App Server code jobs now submit one model turn for several controlled code
actions. The loopback MCP endpoint exposes `perform_action`, `read_source`, and
`get_state`; each action retains the current worker's grant, fresh state/CAS,
trusted fields, executor admission, audit and durable observation chain.

The native process stays alive for that turn and continues to accept exact-turn
steering and emit progress. It is stopped after the turn; this change does not
introduce a cross-task process pool. Native entity thread references/history
remain persistent. Other providers and explicit exec use the existing workflow.

Sources are read through immutable current audit results, with actual page
coverage and a source-version token. A write invalidates previous revision
proofs. Required test profiles and the action budget remain enforced. Final
completion is validated only after the native process and admitted tools settle.

Stop controls deny new actions before interrupting the native turn. Native exit
alone cannot confirm a stop while a host action is unresolved. Unknown results
retain admission/reconciliation evidence. A cancellation signal also covers
reasoning with no active executor action.

Completion also checks the latest durable owner-control record. Undelivered
instructions defer the job to another scheduling turn without replaying prior
actions. A short registry queue fence closes instruction acceptance before the
final action; a later instruction receives an explicit conflict. Pause/cancel
remain available, and an instruction/control write whose acknowledgement was
lost is still checked from storage.

## Evidence

- Before implementation, the strengthened real executor/application scenario
  failed: the job remained active instead of completing in one invocation.
- The implemented scenario completes read → write → fixed test → complete in
  **one** model invocation; the compatibility scenario uses **four**. Both use
  a temporary Git checkout, real job/executor/ledger/memory/package layers and
  a simulated successful sandbox. Source application still uses its own approval
  and is idempotent. These counts are fixture observations, not latency benchmarks.
- The new capability/MCP tests first failed for missing implementation, then
  passed **17/17**. They cover serialization, duplicate mutation IDs, conflicting
  replays, malformed JSON, opaque handles, revocation, abort and close/drain.
- Owning integrated regressions passed **436/436**, zero skipped, before the
  behavior-preserving simplification. They cover provider/router/directory,
  process/stop/steer, worker, task controls and versioned authority.
- Three independent simplification passes completed. Applied one queue-reuse
  finding and two quality findings; the efficiency pass had no material finding.
  The affected regressions then passed **203/203**, zero skipped.
- Cancellation signal forwarding through versioned authority first failed its
  new focused test, then passed after implementation. Continuous worker cases
  cover incomplete pages, outdated page tokens, missing profiles, scope/action
  limits, unknown results, pause during a profile and reasoning-only cancellation.

No separate lint/typecheck command is configured in package.json.

### Real Codex and Docker acceptance

A disposable synthetic repository also passed the actual native Codex App Server
and pinned Docker `node-test` profile, using `gpt-6.1-sol` / `medium`:

- One model invocation performed five audited actions: `read_text`, `write_text`,
  `run_profile`, another `read_text`, and final `complete`.
- The Docker regression test passed. The job/result, memory, work ledger and
  change package completed; explicit local package application updated the
  disposable checkout, and repeated application reused its receipt.
- Original login and native history were used in place. Synthetic session
  references are retained under a dedicated `validation-continuous-20261014-native`
  namespace in the existing trusted private runtime parent. Disposable job/Git
  artifacts are retained privately; they are not production task state.
- An earlier live attempt exposed standard MCP request metadata/optional empty
  arguments rejected by the new strict transport. The model reported blocked,
  no action was admitted, and the job did not falsely complete. A new regression
  failed before the fix, then the capability/MCP suite passed **18/18** and the
  real pipeline passed on rerun. Request metadata is ignored for action authority;
  semantic arguments remain strictly validated. See the
  [MCP tool protocol](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
- Initial probes using an untrusted temporary-parent location failed the existing
  private-directory check before a model run. Acceptance used a dedicated child
  under an already verified private parent; the check was retained.

This verifies a small synthetic development/test/application cycle with a real
model and Docker. It does not establish real OCT compilation/UI/hardware behavior
or real PR #24674 acceptance.

### Full regression run

The full first phase executed **4,698 tests: 4,685 passed, 12 skipped, one failed**.
The failure was `EBUSY` while rewriting a disposable Windows manager script in
test setup, before its recovery assertion. The fixture now retries only `EBUSY`
for at most two seconds; a persistent lock still fails. That exact integration
case passed its isolated rerun, **1/1**. The original full run is recorded as
failed; it is not relabeled green from the rerun. The packaged distribution
phase did not run after that failure and is verified separately below.

### Independent review and fixes

The `ce-code-review mode:agent` receipt is **complete**, verdict **Ready with
fixes**, run `20261014-234252-b4fb6df3`. Seven local reviewer lenses and an
independent validator confirmed two P2 concurrency findings in the pre-fix
snapshot. The fixed Claude adversarial route failed with `API ConnectionRefused`;
its cross-model coverage is degraded and no cross-model corroboration is claimed.
Automatic approval review rejected deletion of its terminal temporary job
directory with `blocked by policy`; artifacts were retained, with no deletion
retry or detached peer work.

One coupled worker/registry fix batch applied **#1 and #2, zero skipped**:

1. Recheck pause/cancel after awaited grant verification and before admission.
2. Check durable instructions before completion; defer undelivered requirements
   without replaying completed actions, and explicitly reject instructions after
   final completion wins the control fence.

The original two real-store/registry regressions failed before the fixes and
passed afterward. Additional races reproduced a late instruction being accepted
and discarded, a persisted instruction with a lost write acknowledgement, and
a persisted pause with a lost acknowledgement. These now reject or defer final
completion as appropriate. The worker/registry suites passed **225/225**, zero
skipped, before the final advisory coverage additions.

Both advisory coverage gaps are now covered: authority revoked between tools
fences the real stored job and prevents a second action/final completion; CLI
lookup failure before MCP construction closes the opaque host capability exactly
once and starts no model process. The final combined owning regressions passed
**447/447**, zero skipped. `git diff --check` passed. All four implementation
units and their verification contracts are addressed; real OCT PR acceptance
remains the separate deployment gate below.

The orchestrator manually scanned the task's production diff, documentation,
MCP compatibility fix and fixture retry. Follow-up fixes were reviewed separately
against the retained findings. The review receipt describes its staged pre-fix
snapshot; this follow-up validation does not rewrite that receipt or assert that
reviewers reran the code. No justified code finding remains unapplied.

### Distribution acceptance

An initial distribution check before committing documentation correctly rejected
dirty release inputs: **16 passed, three committed-tree/privacy guards failed**.
The clean-room install/composition case itself passed. After documentation was
committed as `e09fdfc610`, the complete distribution suite passed **19/19**, zero
skipped, including tracked-tree privacy and clean-room installation/composition.
This paragraph is the subsequent receipt-only documentation amendment; executable
source is unchanged. The committed-tree/privacy checks are repeated after that
amendment. The guards are retained rather than bypassed.

## Live acceptance and preserved state

This turn has not restored the stopped production service, changed private
configuration/authentication/history, published GitHub mutations, or resumed
PR #24674. Its previous fixed preflight passed; continuous real-model development
and final report/parent acceptance remain a separate live gate. PR #24723 remains
excluded because the owner is repairing it manually.

Production still requires the existing snapshot-specific recovery authorization
for `shutdown-failure-20261014-120918-1ff3066ac48941a3b279a1453d6bda96` before
managed recovery/start. Do not interpret source/test completion as service uptime.

After deployment, inspect the first intended job and subsequent scheduling
cycles: same native turn, multiple distinct audit actions, fresh test evidence,
correct final ledger/result, successful same-turn steering and no unconfirmed
stop. Preserve evidence and pause/reconcile on duplicate actions, stale source
pages or premature stop confirmation. Windows build/UI/hardware validation still
requires explicitly configured execution capabilities.
