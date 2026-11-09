import { createWorkflowRouter, normalizeWorkflowRoutingConfig } from "./domain/workflow-router.js";
import { withOwnerWorkRequestDefaultRoute } from "./domain/owner-work-request.js";
import { withPrLifecycleRoutes } from "./domain/pr-lifecycle-routing.js";
import { DEFAULT_ISSUE_ACTIVE_WINDOW_DAYS } from "./domain/prioritizer.js";
import { ProcessExclusiveGuard } from "./lib/process-exclusive-guard.js";
import { WorkflowRoutingService } from "./services/workflow-routing-service.js";

const GUARD_NAME = "mydashboard-workflow-routing-v1";
const RUNTIME_METHODS = Object.freeze([
  "getConfig",
  "replaceConfig",
  "dryRun",
  "ingest",
  "ingestSnapshot",
  "listAssignments",
  "readAssignmentBatch",
  "listAudit",
]);

function sameDefinition(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function createWorkflowRoutingRuntime(
  config,
  {
    store,
    router = createWorkflowRouter(),
    clock,
    operationQueue,
    actionAdmissionGate,
    scopeExitRecoveryReader,
    scopeReentryReader,
    roleHandoffReader,
    headAncestryReader,
    createGuard = (options) => new ProcessExclusiveGuard(options),
  } = {},
) {
  if (config?.workflowRouting === undefined) return null;
  const configuredDefinition = normalizeWorkflowRoutingConfig(
    config.workflowRouting,
  );
  const definition = normalizeWorkflowRoutingConfig(
    withOwnerWorkRequestDefaultRoute(
      withPrLifecycleRoutes(configuredDefinition),
    ),
  );
  if (typeof createGuard !== "function") {
    throw new TypeError("createGuard must be a function");
  }
  const guard = createGuard({ name: GUARD_NAME });
  if (
    !guard ||
    typeof guard.acquire !== "function" ||
    typeof guard.run !== "function" ||
    typeof guard.close !== "function"
  ) {
    throw new TypeError("workflow routing guard is invalid");
  }
  let closePromise = null;
  const close = () => {
    closePromise ||= Promise.resolve().then(() => guard.close());
    return closePromise;
  };
  try {
    await guard.acquire();
    const service = new WorkflowRoutingService({
      store,
      router,
      exclusiveLease: guard,
      issueActiveWindowDays:
        config.githubRead?.issueActiveWindowDays ??
        DEFAULT_ISSUE_ACTIVE_WINDOW_DAYS,
      ...(actionAdmissionGate === undefined ? {} : { actionAdmissionGate }),
      ...(scopeExitRecoveryReader === undefined ? {} : { scopeExitRecoveryReader }),
      ...(scopeReentryReader === undefined ? {} : { scopeReentryReader }),
      ...(roleHandoffReader === undefined ? {} : { roleHandoffReader }),
      ...(headAncestryReader === undefined ? {} : { headAncestryReader }),
      ...(clock ? { clock } : {}),
      ...(operationQueue ? { operationQueue } : {}),
    });
    await service.recover();
    const { current } = await service.getConfig();
    if (!current || !sameDefinition(current.definition, definition)) {
      await service.replaceConfig({
        definition,
        expectedVersion: current?.version || 0,
        changedBy: "local-config",
      });
    }
    const runtime = { close };
    for (const method of RUNTIME_METHODS) {
      runtime[method] = (...args) => service[method](...args);
    }
    return Object.freeze(runtime);
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the startup error while the OS guard remains fail closed.
    }
    throw error;
  }
}
