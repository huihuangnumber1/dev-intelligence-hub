# Running-task controls: implementation validation

Date: 2026-10-13. Scope: the running-task plan and its integration changes after
`36b616ecc6`. This is a source validation record, not a live business acceptance
or a claim that the entire system runs without blockers.

## Implemented behavior

- Global active-task list and detail, supplemental requirements, scheduler
  priority, pause, resume and cancellation.
- Run UUID and settings revision fence stale controls. Requirements and holds
  persist in the existing data store; execution permissions remain unchanged.
- Changed requirements discard superseded model decisions. Observed controlled
  actions are never replayed to apply a new instruction.
- Accepted pause/cancel precedes ordinary retry handling. Failed settlement
  retains a pending hold; unconfirmed native reap requires positive recovery
  evidence. Terminal code jobs retain their actual status after a late control.
- The app-server protocol adapter has fixture coverage. Its production runner
  rejects before spawn until equivalent isolation and contained bidirectional
  supervision are available. Native exec remains the default.

## Verification

| Check | Observed result | Practical limit |
| --- | --- | --- |
| Integrated affected suite | 744 passed, 0 failed | Includes expired-claim settlement and additional protocol/job regressions; before the final adjustment-limit branch fix |
| Final registry/loop regression suite | 144 passed, 0 failed | Includes a witnessed red/green check that automatic pause settlement failure cannot become ordinary retry |
| Final native/protocol regression suite | 40 passed, 0 failed | Includes cancellation racing certified no-spawn transport rejection without leaving an unknown session journal |
| Final stop-evidence guard | 28 passed, 0 failed | Native readiness cannot certify legacy or Claude CLI termination in a mixed configuration |
| Committed-tree distribution checks at `365e49132e` | 19 tests: 16 passed, 3 reported failed | Two ACL setup failures; the nested lifecycle failure also fails its parent test |
| Final controls suite | 176 passed, 0 failed | Registry, real code-job store/worker/settler, protocol, HTTP-attention contract and Chromium fixture |
| Bounded application shutdown cases | 2 passed, 0 failed in an isolated rerun | Both had hit causal poll bounds under the full concurrent workload |
| Full main test command | 4,290 tests: 4,260 passed, 20 failed, 10 skipped | Started before final fixes; not a passing final-tree full-suite receipt |
| Native CLI initialization | Accepted initialization; isolated process exit confirmed | No model turn, real task, authentication migration or business write |
| Native app-server isolation capability | Installed CLI rejected required ignore-config/rules options | Production transport remains unavailable; no fixed version gate |
| Static checks | Modified JavaScript parses; `git diff --check` passed | No lint command is configured in package scripts |
| Private configuration | Hash unchanged from the pre-work baseline | Configuration, credentials and session histories were not migrated |

The full-run failures were classified from their actual stacks: one old
attention-dialog count assertion was updated for the separate task detail
dialog; two bounded shutdown cases passed on isolated rerun; 17 Windows cases
failed while preparing ACL fixtures (`SetAccessControl`, unauthorized operation),
before their intended behavior could be exercised. Production checks were not
weakened to accommodate fixture permissions.

After the local implementation commit, committed-input provenance, npm package
contents and both distributable/whole-tree privacy scans passed. A clean payload
installed and loaded its safe bootstrap without private `config.json`; packed
manager and clean-payload managed lifecycle acceptance remained blocked at two
Windows ACL preparation sites. The three reported failures include a nested
lifecycle test and its parent. The distribution suite is not claimed green.

The real code-job integration covers both pause and cancel after an admitted
action's response is interrupted, a fresh registry loaded from durable settings,
pending reconciliation, the same job identity, fresh control revisions and one
executor perform. The protocol fixture independently gates interrupt ACK,
interrupted notification and process exit; neither ACK nor notification alone
settles pause. Other thread/turn completion, mismatched resume and wrong-turn
steer ACKs are rejected or ignored as appropriate.

An owner stop can settle the exact original revision and lease identity after
maintenance outlasts that lease. It cannot authorize worker execution or stop a
newer claim; original revision/lease conflicts and active-intent fences remain.

## Review

Independent review run: `20261013-121623-c5b68bfd`, terminal status `degraded`.
All eight selected local lenses, merge and independent closure validation
completed; six original defect/test claims were resolved and no current
actionable finding remained. The additional cross-model pass had no output
because its worker lacked jq. Automatic approval review rejected cleanup of its
terminal temporary artifacts with the reason `blocked by policy`; they are
preserved, with no peer process running. No source left through that peer job.

Code review: skipped (ce-code-review unavailable)

This is the workflow's required completion-gate label for an attempted review
whose terminal receipt is degraded, rather than a claim that no local review
occurred. A final manual diff scan checked control authority, stale run/revision
fences, original-claim settlement, non-replay and private-state exclusions.
After the receipt, that scan added the conservative mixed-CLI stop-evidence
guard and its scoped regression. Independent addendum
`closure-addendum-native-stop-evidence.json` completed with no findings, one
targeted test passed, and composition syntax checked; parent review status stays
degraded. Original findings and snapshots remain in the
local review artifacts; this document contains no credentials or runtime logs.

Simplification: reuse, quality and efficiency prompts were applied inline after
the host could not admit additional simplify workers. Existing operation queues,
ledger transitions, code-job controls and input validation were reused. This
manual simplification pass does not substitute for the independent code review.

## Deployment boundary

The existing service was not restarted. Its health endpoint returned 200, while
the new task-runs endpoint returned 404, confirming the running process has not
loaded this implementation. Managed status also reported an identity mismatch
during the work. Disk space remains below the normal startup reserve. Do not
force restart, bypass the reserve or erase retained histories to activate it.

Before activation, restore adequate disk space and use the existing managed
lifecycle/recovery procedure. Then verify an actual model task appears in the
list, a queued item does not, a harmless requirement is reflected in the next
decision, and pause/resume retains the same item. Verify cancellation settlement
on one controlled test job. Keep native transport unset or `exec`.

During the first real task cycle, the maintainer should watch stable
`TASK_RUN_*` / `STRUCTURED_PROVIDER_*` diagnostics and compare the running list
with ledger/job state. If a superseded decision is dispatched, a code action
repeats, or the UI claims stopped without settlement, pause the affected role
and preserve its state for investigation. A healthy web endpoint alone is not
acceptance of automated PR review or a complete development/test workflow.

Publishing remains outside this change: local branch history contains unrelated
pre-existing commits and must not be pushed wholesale.
