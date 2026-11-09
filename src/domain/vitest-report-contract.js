// Kept self-contained so the configured asset embeds this exact implementation.
export function translateVitestReport(reportText, processExitCode) {
  let report;
  try { report = JSON.parse(reportText); } catch {}
  if (!report || !Array.isArray(report.testResults)) return { exitCode: processExitCode || 1, stdout: "", diagnostic: "Missing or invalid actual Vitest JSON report" };
  const assertions = report.testResults.flatMap(suite => Array.isArray(suite.assertionResults) ? suite.assertionResults : []);
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0, cancelled: 0 };
  const lines = ["TAP version 13"];
  assertions.forEach((assertion, index) => {
    const category = assertion.status === "passed" ? "passed" : assertion.status === "failed" ? "failed" : assertion.status === "todo" ? "todo" : ["pending", "skipped"].includes(assertion.status) ? "skipped" : "cancelled";
    counts[category]++;
    const title = String(assertion.fullName || assertion.title || "Vitest assertion").replace(/[\r\n\x00-\x1f]/gu, " ");
    lines.push(`${category === "failed" || category === "cancelled" ? "not ok" : "ok"} ${index + 1} - ${title}${category === "skipped" ? " # SKIP" : category === "todo" ? " # TODO" : ""}`);
  });
  lines.push(`1..${assertions.length}`, `# tests ${assertions.length}`, `# pass ${counts.passed}`, `# fail ${counts.failed}`, `# cancelled ${counts.cancelled}`, `# skipped ${counts.skipped}`, `# todo ${counts.todo}`);
  const passed = processExitCode === 0 && report.success === true && counts.passed > 0 && counts.failed === 0 && counts.cancelled === 0 && !report.testResults.some(suite => suite.status === "failed");
  return { exitCode: passed ? 0 : processExitCode || 1, stdout: lines.join("\n") + "\n", diagnostic: JSON.stringify({ suites: report.testResults.length, assertions: assertions.length, counts, success: report.success }) };
}

export function matchesVitestDependencyBinding(packageSha256, lockSha256, expectedPackageSha256, expectedLockSha256) {
  return [packageSha256, lockSha256, expectedPackageSha256, expectedLockSha256].every(value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)) && packageSha256 === expectedPackageSha256 && lockSha256 === expectedLockSha256;
}
