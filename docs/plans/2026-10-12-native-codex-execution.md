# Native Codex execution

## Goal

Keep the existing GitHub automation, immutable PR bindings, task ledger and
controlled code execution. Add a thin Codex CLI login route that leaves
authentication and conversation storage with Codex, and document the actual
runtime boundaries. Existing installations retain their configuration.

## Implementation

1. Fix the legacy provider's preparation-failure credential fence. Release the
   shared lease only after preparation has settled, no process can still start,
   and verified cleanup succeeds. Preserve fencing for uncertain processes,
   credential publication and cleanup.
2. Add `credentialMode: "codex-native-login"` for Codex providers. Use the service
   account's startup `CODEX_HOME` or default Codex home, a serialized native
   execution route, persistent session references, and supervised CLI processes.
   Do not copy auth files or session directories. Pass task input through stdin,
   bind PR reads to the existing read-only MCP reader, validate final structured
   decisions, and keep GitHub writes under the existing publisher.
3. Expose the mode in configuration validation and the UI. Explain native versus
   legacy login, native session storage, unattended execution, diagnostics,
   migration and rollback. Correct stale claims about MCP, sessions and automatic
   authorization in the README and architecture guide.

## Verification

- Reproduce and cover the legacy pre-process failure before changing behavior;
  an independent subsequent task must run after a settled preparation failure.
- Native execution must use the original Codex home without staging credentials;
  resume the correct entity's session; serialize shared native profile access;
  handle cancellation, timeout, malformed output and unknown process termination.
- Review must still require complete change-set reading and current immutable
  source identity. No native call directly publishes a GitHub mutation.
- Validate the new mode through backend and frontend contracts; reject it for
  Claude and preserve the existing default modes.
- Run focused tests and review the integrated change. Report live verification
  separately from fixture evidence; do not claim a real PR completed from tests.

## Operational boundaries

Configuration, login state, retained conversations and task history are private.
Native mode is an explicit configuration choice, with no automatic fallback or
silent migration of historical sessions. Installing Retinue, replacing the task
ledger, changing the selected model, or granting arbitrary GitHub write access is
outside this change.

## Implementation result

The native route, configuration/UI projection, diagnostics and documentation are
implemented. The compatibility preparation fence now releases only after safe
settlement and cleanup. Review follow-up fixed capability propagation through
the configured provider boundary and preserved runner-owned pre-spawn evidence
so failed preparation does not strand a fresh entity's pending session journal.
Raw native providers also declare their session isolation key. Native invocation
disables automatic host `AGENTS.md` injection.

A real supervised cancellation exposed a Windows wrapper input file left behind
when forced termination skipped its `finally` block. After confirmed reaping,
native cleanup now removes only strictly named runner inputs that are regular,
single-link files. Unknown entries, directories and hard links are retained and
reported as cleanup failures. Failed or cancelled fresh threads retain their
exact native IDs for the next invocation; conflicting IDs cannot replace them.

Validation separates fixture evidence from real execution:

- Full test phase: 4,244 tests, 4,230 passed, 12 skipped and two managed-recovery
  fixture setup failures at unmanaged-listener checks. Both failed tests
  passed when rerun alone without source or assertion changes.
- Review follow-up: native provider/runner 35/35; configured workforce/role and
  immutable review-reader integration 76/76.
- Additional real-process session/cancellation and identity-conflict coverage:
  native provider/runner 43/43; final native-only verification 25/25. Cleanup
  negatives verify preservation of disguised directories, hard links and
  unknown file names.
- Final combined integration run: 456 tests, 453 passed, two skipped, and one
  stdout/stderr-limit test failed during the concurrent run. That unchanged test
  passed when rerun alone. This is recorded separately from the passing focused
  regressions rather than describing the combined run as fully green.
- The real official CLI passed native login readiness, an ephemeral synthetic
  model call and a two-turn entity session round-trip with a random marker.
  Existing configuration and conversation history were preserved. The new
  synthetic conversation and its references are retained as private evidence.
- A two-turn real CLI check also passed against the actual loopback MCP reader
  backed by synthetic GitHub responses. Each turn used a newly created endpoint,
  completed manifest/diff reading, and returned the current source value after
  native resume. No real repository or GitHub operation was involved; this does
  not establish adversarial sandbox enforcement or real PR publication.
- Committed-tree distribution validation: 19 tests, 16 passed and three failed.
  Release-input consistency and privacy checks passed. One packaged-manager
  test failed at an unmanaged-listener check and passed an unchanged isolated
  rerun (1/1). The remaining parent/subtest failures were clean-install readiness:
  HTTP 200 was reached, but the data volume's approximately 97.6% utilization
  triggered the critical capacity guard. Do not weaken that guard to make this
  test pass. The full distribution run is not green.

The active service has not been migrated to native mode. A real configured PR
Review, publication and assignment handoff remain separate operational
acceptance gates, as recorded in `docs/OPEN_FOLLOWUPS.md`.

### Review evidence and limit

The attempted dedicated review returned `degraded`: seven local source reviewers
and an independent validator completed, but the cross-model worker lacked `jq`
before dispatch. Automatic approval review also rejected deletion of its
terminal temporary job artifacts with `blocked by policy`; the artifacts were
preserved and no process remains active. Both confirmed source findings were
fixed and covered by targeted regressions.

Code review: skipped (ce-code-review unavailable) — the attempted top-level
review could not produce a completed receipt after its bounded recovery. Final
validation therefore includes an explicit manual scan of the current native
provider/store and all changed production integration, configuration and
diagnostic code. This fallback does not claim independent cross-model coverage.

## Post-deploy monitoring and validation

The maintainer activating native mode should inspect the selected-mode readiness
and the first intended role task after its managed restart. Confirm one CLI
attempt, one native session reference, a structured ledger result, and no auth
or history copy. On the next cycle for the same entity, verify the referenced
thread is resumed. For Review, inspect complete-read evidence, current Head,
the published Review receipt and the configured assignment handoff.

Observe the first task and the following scheduled cycles during the first day.
Unexpected credential-mode changes, a fresh thread replacing a known entity,
or mismatched GitHub publication are rollback triggers: pause the affected role,
preserve evidence, reconcile any unknown write, restore the previous mode and
perform a managed restart. An uncertain process exit should remain fenced;
retain its marker and investigate it rather than clearing it to restore traffic.
