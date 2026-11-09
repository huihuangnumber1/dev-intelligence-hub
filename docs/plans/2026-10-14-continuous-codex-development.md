# Continuous Codex development

## Goal

Let one native Codex App Server turn perform several authorized code actions,
show progress, and receive owner steering. Reuse the controlled executor and
durable job state instead of starting another model process after each action.
The reference is agent-feishu-bridge at commit
`869fd69e27384040019fbf69505a336151ed9159`; its code is not copied.

## Scope and decisions

- Native App Server code jobs use a process-private capability and a temporary
  loopback MCP endpoint. Other providers keep their existing decision workflow.
- MCP exposes `perform_action`, `read_source`, and `get_state`. Semantic actions
  remain validated by the existing action contract. Trusted action IDs, hashes,
  workspace revisions, grants, and fixed profiles remain host selected.
- Tools can list, read, search, write permitted files, and run fixed profiles.
  The final structured `complete` is executed only after the native process and
  admitted MCP calls have settled. Shell and direct GitHub writes stay outside
  this channel.
- One outer task run owns live progress and steering. Side effects never repeat
  merely because an owner instruction missed live delivery.
- Reads are paged without a total source-size cap. Each page belongs to a
  successful audited read at the current workspace revision. A write invalidates
  all old revision proofs. Completion checks current required profiles and reads.
- Stop first revokes new tool admission, drains accepted work, and verifies native
  process exit. Unknown action results keep the existing reconciliation fence.
- Continuous code turns have an explicit 15-minute minimum budget (or the longer
  configured provider timeout); ordinary reasoning/review timeouts are unchanged.
- Existing configuration, login, retained history, production data, and PR state
  are preserved. Production lifecycle recovery uses the existing authorized
  procedure separately.

## Implementation units

1. Add the opaque execution capability and serialized, revocable MCP transport.
   Deduplicate repeated mutation request IDs; reject conflicting replays; drain
   admitted calls before close. Add transport and capability regression tests.
2. Carry the capability through directory/router/provider boundaries and expose
   it only for native App Server. Configure and verify the exact tool inventory;
   preserve read-only review isolation. Add provider/runner integration coverage.
3. Execute fresh worker actions within one model invocation. Reuse action
   preparation/admission/audit/result recording, refresh state between tools,
   preserve full-read proofs, and retain action-count/authority/stop gates.
4. Verify the integrated flow, review the changes, and document operation,
   limits, and evidence separately from live PR acceptance.

## Verification contract

- A single model invocation performs read, full page read, write, fixed profile,
  and completion through real job storage and executor layers.
- Current grants, path scope, required profiles, and workspace revisions are
  checked between actions; missing profiles or incomplete reads reject completion.
- Duplicate transport calls do not repeat mutations. Calls serialize and reject
  after revocation; close waits for the active callback.
- Pause/cancel/timeout do not report stopped while a host action is unresolved.
  Unknown results reconcile without replay. Steering keeps the same native turn.
- Existing nonnative code decisions and read-only PR Review regressions pass.
- Synthetic process/MCP verification is distinguished from real Codex and real
  PR acceptance. No production recovery or GitHub mutation is inferred from tests.

## Definition of done

All four units are implemented, owning regressions pass, changed code is reviewed,
and user/architecture/testing documentation describes the actual route and limits.
Report live acceptance independently; do not describe fixture results as a
completed development or test cycle on PR #24674.
