import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);

function functionSource(name) {
  const start = appSource.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const signatureEnd = appSource.indexOf(") {", start);
  assert.notEqual(signatureEnd, -1, `${name} must have a function body`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let index = bodyStart; index < appSource.length; index += 1) {
    if (appSource[index] === "{") depth += 1;
    if (appSource[index] === "}") depth -= 1;
    if (depth === 0) return appSource.slice(start, index + 1);
  }
  assert.fail(`${name} must have a complete function body`);
}

test("employee view loads every configured role and exposes independent controls", () => {
  assert.match(appSource, /fetch\("\/api\/employees"/);
  assert.match(appSource, /employeeRoles\.map\(employeeRoleCard\)/);
  assert.match(appSource, /data-role-control=/);
  assert.match(appSource, /data-role-run=/);
  assert.match(
    appSource,
    /\/api\/employees\/\$\{encodeURIComponent\(roleId\)\}\/control/,
  );
  assert.match(
    appSource,
    /\/api\/employees\/\$\{encodeURIComponent\(roleId\)\}\/run/,
  );
});

test("employee cards display their assigned model, mission, and permissions", () => {
  for (const value of [
    "roleBrainLabel(role)",
    "roleTaskBrainLabel(role)",
    "日常大脑",
    "任务大脑",
    "role.mission",
    "permissions.join",
    "role.lastErrorCode",
  ]) {
    assert.equal(appSource.includes(value), true, value);
  }
});

test("employee cards expose workload counts, current tasks, and a role ledger link", () => {
  for (const value of [
    "role.workload",
    "待领取",
    "处理中",
    "等待",
    "阻塞",
    "data-role-work",
    "查看该岗位任务",
    "工作台账未启用",
  ]) {
    assert.equal(appSource.includes(value), true, value);
  }
  assert.match(appSource, /workView\.setRoleFilter\(roleId\)/);
  assert.match(appSource, /activateView\("work"\)/);
});

test("PR engineer work exposes the review stage and next owner", () => {
  for (const value of [
    "PR Review 工作方式",
    "自动 Review 和后续分配可在配置中心关闭；记录在下方查看",
    "Review 建议已生成，等待你确认发布",
    "下一责任人：",
    "data-role-confirmations",
    "处理确认队列",
  ]) {
    assert.equal(appSource.includes(value), true, value);
  }
});

test("PR promoter visibly stays within triage responsibility", () => {
  assert.match(appSource, /正在初判/);
  assert.match(
    appSource,
    /只做发现、初判和分流；代码 Review 交给 PR 工程师/,
  );
  assert.match(
    appSource,
    /pendingConfirmationCount = employee\.confirmationQueue\?\.length \|\| 0/,
  );
});

test("PR employee pending work has a direct, explained confirmation entry", () => {
  for (const value of [
    "处理待确认（",
    "需要你确认什么",
    "data-pr-job-confirmation",
    "处理这项确认",
    "处理下一项确认",
    "接受或驳回都只记录本地结论",
    "随后会生成一项独立的 GitHub 发布确认",
  ]) {
    assert.equal(appSource.includes(value), true, value);
  }
  assert.match(
    appSource,
    /async function handleRoleConfirmations\(event\)[\s\S]*requestedJob[\s\S]*showJobConfirmation\(requestedJob\)/,
  );
  assert.match(
    appSource,
    /async function showJobConfirmation\(job\)[\s\S]*kind: "review_draft"[\s\S]*showConfirmationEntry[\s\S]*\/api\/confirmations\/\$\{encodeURIComponent\(job\.confirmationId\)\}/,
  );
});

test("main loading applies dashboard and confirmations independently of the employee roster", () => {
  const loadSource = functionSource("load");
  const mainRequests = loadSource.slice(
    loadSource.indexOf("await Promise.allSettled(["),
    loadSource.indexOf("]);", loadSource.indexOf("await Promise.allSettled([")),
  );

  assert.match(loadSource, /void loadEmployeeRoles\(\);/);
  assert.match(mainRequests, /fetchDashboard\(\)/);
  assert.match(mainRequests, /fetchConfirmationQueue\(\)/);
  assert.doesNotMatch(mainRequests, /loadEmployeeRoles\(\)/);
  assert.ok(
    loadSource.indexOf("applyConfirmationQueue") <
      loadSource.indexOf("queueMicrotask(showNextConfirmation)"),
    "the independently fetched confirmation snapshot must be applied before opening the dialog",
  );
});

test("employee roster GETs abort predecessors and reject out-of-order responses", () => {
  const rosterSource = functionSource("loadEmployeeRoles");

  assert.match(rosterSource, /const sequence = \+\+employeeRolesRequestSequence/);
  assert.match(rosterSource, /employeeRolesAbortController\?\.abort\(\)/);
  assert.match(rosterSource, /const controller = new AbortController\(\)/);
  assert.match(rosterSource, /signal: controller\.signal/);
  assert.match(rosterSource, /sequence !== employeeRolesRequestSequence/);
  assert.match(rosterSource, /sequence < lastAppliedEmployeeRolesRequest/);
  assert.match(rosterSource, /lastAppliedEmployeeRolesRequest = sequence/);
});

test("aborted roster requests stay silent while real failures remain local to the employee view", () => {
  const rosterSource = functionSource("loadEmployeeRoles");
  const abortGuard = rosterSource.indexOf('error?.name === "AbortError"');
  const errorAssignment = rosterSource.indexOf("employeeRolesError = error.message");

  assert.notEqual(abortGuard, -1);
  assert.ok(abortGuard < errorAssignment, "abort exits before recording an error");
  assert.doesNotMatch(rosterSource, /statusBanner/);
  assert.match(appSource, /其他指挥功能不受影响/);
});

test("employee mutations refresh the roster without delaying confirmation refresh", () => {
  for (const name of ["handleEmployeeRun", "handleRoleRun"]) {
    const source = functionSource(name);
    assert.match(source, /void loadEmployeeRoles\(\);/);
    assert.doesNotMatch(source, /Promise\.all\([\s\S]*loadEmployeeRoles/);
    assert.ok(
      source.indexOf("void loadEmployeeRoles()") <
        source.indexOf("await refreshConfirmationQueue"),
      `${name} must start its best-effort roster refresh before awaiting confirmations`,
    );
  }
});

test("role mutations bind responses to their request-time dashboard sequence", () => {
  for (const name of ["handleRoleControl", "handleRoleRun"]) {
    const source = functionSource(name);
    const capture = source.indexOf("const sequence = ++requestSequence");
    const fetchStart = source.indexOf("await fetch(");

    assert.notEqual(capture, -1, `${name} must capture a request sequence`);
    assert.ok(capture < fetchStart, `${name} must sequence before its request`);
    assert.match(source, /applyDashboard\(await response\.json\(\), sequence\)/);
    assert.doesNotMatch(
      source,
      /applyDashboard\(await response\.json\(\), \+\+requestSequence\)/,
    );
  }
});

test("blocked-job recovery submits the immutable dialog intent", () => {
  const source = functionSource("handleBlockedJobResolution");

  assert.match(appSource, /data-expected-revision=/);
  assert.match(source, /isPrEmployeeRecoveryIntentCurrent/);
  assert.match(source, /expectedRevision: Number\(container\?\.dataset\.expectedRevision\)/);
  assert.match(source, /body: JSON\.stringify\(recoveryRequest\)/);
  assert.match(source, /closeBlockedJobDialog\(container\)/);
  assert.doesNotMatch(source, /closeDetailDialog\(\)/);
  assert.doesNotMatch(source, /expectedRevision: dashboard\.employee\.role\.revision/);
  assert.doesNotMatch(source, /并已触发岗位运行/);
});
