import { validateExecutionId, validateWorkspaceId } from "./code-execution-policy.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const INVALID_CHARACTER = /[<>:"|?*\\\u0000-\u001f\u007f]/u;

function executorIdentity(workspaceId, executionId = workspaceId) {
  try {
    validateWorkspaceId(workspaceId);
    validateExecutionId(executionId);
    return true;
  } catch {
    return false;
  }
}

function sourceWorkspace(segments) {
  return segments[1] === "workspaces" && segments.length > 4 &&
    executorIdentity(segments[2], segments[3]);
}

function windowsTestData(segments) {
  if (segments[1] !== "windows-tests" || !SHA256.test(segments[2]) ||
      segments[3] !== "data") return false;
  return segments[4] === "workspace" && segments.length > 5 ||
    segments[4] === "resources" && segments.length > 6 &&
      executorIdentity(segments[5]);
}

function generatedTestLibrary(segments, directory) {
  if (segments[1] !== "workspaces" || segments[2] !== ".test-library") return false;
  if (directory) {
    return segments.length === 3 || segments.length === 4 && SHA256.test(segments[3]);
  }
  return segments.length === 5 && SHA256.test(segments[3]) && segments[4] === "test.mjs";
}

export function isCanonicalBackupPath(value, { directory = false } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024 ||
      Buffer.byteLength(value, "utf8") > 4_096 || value !== value.normalize("NFC") ||
      INVALID_CHARACTER.test(value)) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." ||
      segment === ".." || /[. ]$/u.test(segment) || WINDOWS_DEVICE.test(segment))) return false;
  if (!segments.some((segment) => segment.startsWith("."))) return true;

  // Executor source copies and pinned test resources own their dotfiles. Other
  // durable namespaces keep the default hidden-path denial; generated assets
  // have the exact DockerTestSandbox layout rather than a general exception.
  return segments[0] === "code-executor" && (
    sourceWorkspace(segments) || windowsTestData(segments) ||
    generatedTestLibrary(segments, directory)
  );
}
