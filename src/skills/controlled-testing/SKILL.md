---
name: controlled-testing
description: Plan and assess version-bound tests using the configured reusable test library and controlled executor.
---

# Controlled testing workflow

## Establish the target

Read the task objective, acceptance criteria, changed code, existing tests and available execution capabilities. Bind conclusions to the supplied repository, PR Head and tested workspace revision. Reuse existing tests and configured library assets before proposing new ones. A previous passing result does not prove a new revision passes.

## Execute and observe

1. Run relevant unit tests through the configured test profiles. Repository inventory, source scanning and merge-marker checks are preflight checks; their success does not prove compilation, unit tests or product behavior passed.
2. Run the applicable application scenarios only when an execution adapter, build, approved test data and required dependencies are available. A testing skill describes a method; it does not grant shell access, desktop access or extra actions. In a controlled code job, request only run_profile; the host selects the configured profile. Never invent a command or select a profile identifier.
3. For OCT desktop scenarios, follow the VanGogh C5/PEL workflow when a corresponding Windows UI test adapter is configured: verify the actual build and process, select the approved test database and sample, load the examination through the patient page and CaptureTableView, observe the requested page and inspect actual screenshots. Respect the selected product's login flow. Mock results cover only mock behavior; hardware-dependent scenarios remain pending real-device validation. Never infer UI success from a window, log message or preflight receipt alone.
4. After a fix, rerun the failing scenario and affected adjacent checks against the new revision. Preserve failed runs and produce a separate result for the retest. Do not silently replace a failure with an old passing record.

## Classify the result

- Passed: the executed checks and observed acceptance criteria passed for the bound revision. State the exact coverage and remaining untested scope.
- Code defect: executed tests demonstrate a reproducible mismatch with the requirement. Preserve steps, expected/actual behavior and logs; hand off a concrete repair objective through the configured development capability when permitted.
- Environment blocked: compilation tools, login, runner, database, sample or process cleanup is unavailable. State the actual dependency and diagnostic. Do not ask development to modify product code to repair an execution environment, and do not repeat an unchanged failing attempt.
- Hardware pending: record which acceptance criteria require a real device and continue independent executable checks.
- Inconclusive: distinguish absent evidence from a demonstrated defect. Ask the owner only for a material ambiguity or necessary information unavailable from the task, code and discussion. Routine execution authorization is decided by the configured policy.

## Deliver evidence

Use only the actual execution records supplied by the trusted producer. An authoritative test-report must reference the matching completed verify job; prose, a manual plan, a preflight pass or an invented screenshot cannot substitute for it. If required product tests are not executable, report that gap explicitly rather than claiming full test completion. Submit or complete only within the task's existing delivery contract and allowed intents.

Reusable regression scripts belong in the versioned test library after verification. Each execution retains its own code revision, asset binding, outcome and evidence; do not convert transient AI operations into a verified reusable test automatically. Keep credentials and personal test data out of reports and reusable assets.
