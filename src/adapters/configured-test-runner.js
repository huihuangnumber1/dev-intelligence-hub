import { lstat } from "node:fs/promises";
import { isWindowsTestProfile } from "../domain/windows-test-profile.js";
import { WindowsTestRunnerError } from "./windows-fixed-test-runner.js";

export class ConfiguredTestRunner {
  #profileRunners = new Map();
  constructor({ dockerRunner = null, windowsRunner = null, profiles }) {
    if (!profiles || Object.getPrototypeOf(profiles) !== Object.prototype) {
      throw new WindowsTestRunnerError("INVALID_SANDBOX_CONFIG", "Configured test profiles are invalid");
    }
    this.dockerRunner = null;
    this.windowsRunner = null;
    for (const [id, profile] of Object.entries(profiles)) {
      const native = isWindowsTestProfile(profile);
      const runner = native ? windowsRunner : dockerRunner;
      const methods = ["run", "cleanup", "getProfileFingerprint", ...(native ? ["executionDirectory"] : [])];
      if (!["node-test", "node-script", "windows-test", "windows-build"].includes(profile?.kind) ||
        !runner || methods.some((method) => typeof runner[method] !== "function")) {
        throw new WindowsTestRunnerError("INVALID_SANDBOX_CONFIG", "Configured test runner is unavailable");
      }
      this.#profileRunners.set(id, runner);
      if (native) this.windowsRunner = runner;
      else this.dockerRunner = runner;
    }
  }
  #runner(profileId) {
    const runner = this.#profileRunners.get(profileId);
    if (!runner) throw new WindowsTestRunnerError("SANDBOX_PROFILE_NOT_FOUND", "Configured test profile was not found");
    return runner;
  }
  getProfileFingerprint(profileId) {
    return this.#runner(profileId).getProfileFingerprint(profileId);
  }
  async run(request) {
    return this.#runner(request?.profileId).run(request);
  }
  async readProfileReadiness(request) {
    const runner = this.#profileRunners.get(request?.profileId);
    if (!runner || runner !== this.dockerRunner || typeof runner.readProfileReadiness !== 'function') return null;
    return runner.readProfileReadiness(request);
  }
  async readSettledPreparationFailure(request) {
    const runner = this.#profileRunners.get(request?.profileId);
    if (!runner || runner !== this.windowsRunner || typeof runner.readSettledPreparationFailure !== 'function') return null;
    return runner.readSettledPreparationFailure(request);
  }
  async cleanup(request) {
    if (this.windowsRunner) {
      const directory = this.windowsRunner.executionDirectory(request?.executionId, request?.actionId);
      let exists = false;
      try { await lstat(directory); exists = true; }
      catch (error) {
        if (error.code !== "ENOENT") {
          throw new WindowsTestRunnerError("SANDBOX_CLEANUP_FAILED", "Windows execution ownership could not be determined", { cleanupPending: true });
        }
      }
      // A pending directory also owns cleanup: missing or corrupt native leases
      // must remain fenced, never fall through to an unrelated Docker cleanup.
      if (exists || !this.dockerRunner) return this.windowsRunner.cleanup(request);
    }
    return this.dockerRunner?.cleanup(request);
  }
}
