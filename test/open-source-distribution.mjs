import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const maximumDiagnosticCharacters = 8_000;

function diagnostic(result) {
  return [result.error?.message, result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .slice(-maximumDiagnosticCharacters);
}

function npmInvocation(arguments_) {
  const candidates = [
    process.env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ];
  const npmCli = candidates.find(
    (candidate) => typeof candidate === "string" && existsSync(candidate),
  );
  if (npmCli) {
    return { command: process.execPath, arguments: [npmCli, ...arguments_] };
  }
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      arguments: ["/d", "/s", "/c", `npm ${arguments_.join(" ")}`],
    };
  }
  return { command: "npm", arguments: arguments_ };
}

function runNpm(arguments_, cwd, timeout = 120_000) {
  const invocation = npmInvocation(arguments_);
  return spawnSync(invocation.command, invocation.arguments, {
    cwd,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function managerPowerShell() {
  if (process.platform === "win32") {
    const executable = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    return existsSync(executable) ? executable : null;
  }
  const located = spawnSync("which", ["pwsh"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return located.status === 0 ? located.stdout.trim() : null;
}

function protectWindowsFixtureDirectory(directory, powershell) {
  if (process.platform !== "win32") return;
  const encodedDirectory = Buffer.from(directory, "utf8").toString("base64");
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDirectory}'))
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($current)
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [Security.AccessControl.PropagationFlags]::None
$allow = [Security.AccessControl.AccessControlType]::Allow
foreach ($sid in @($current, $system, $administrators)) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allow)
  [void]$acl.AddAccessRule($rule)
}
[IO.DirectoryInfo]::new($target).SetAccessControl($acl)
`;
  const result = spawnSync(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(
    result.status,
    0,
    `clean environment ACL setup failed:\n${diagnostic(result)}`,
  );
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function cleanManagerEnvironment(environmentRoot, sourceEnvironment = process.env) {
  const environment = {};
  const replacedNames = new Set([
    "appdata",
    "codex_home",
    "gh_config_dir",
    "home",
    "localappdata",
    "path",
    "temp",
    "tmp",
    "userprofile",
    "xdg_runtime_dir",
  ]);
  const sensitiveName =
    /(?:token|secret|password|credential|cookie|api[_-]?key|auth|proxy|github|openai|doubao|ark)/iu;
  for (const [name, value] of Object.entries(sourceEnvironment)) {
    if (
      replacedNames.has(name.toLowerCase()) ||
      name.startsWith("MYDASHBOARD_") ||
      sensitiveName.test(name)
    ) {
      continue;
    }
    environment[name] = value;
  }
  const home = path.join(environmentRoot, "clean-home");
  const appData = path.join(environmentRoot, "clean-app-data");
  const localAppData = path.join(environmentRoot, "clean-local-app-data");
  const temporary = path.join(environmentRoot, "clean-temp");
  const runtime = path.join(environmentRoot, "clean-runtime");
  Object.assign(environment, {
    APPDATA: appData,
    HOME: home,
    LOCALAPPDATA: localAppData,
    TEMP: temporary,
    TMP: temporary,
    USERPROFILE: home,
    XDG_RUNTIME_DIR: runtime,
    [process.platform === "win32" ? "Path" : "PATH"]:
      path.dirname(process.execPath),
  });
  return {
    environment,
    directories: [home, appData, localAppData, temporary, runtime],
  };
}

function runManager({ executable, rootDirectory, environment, action }) {
  const arguments_ = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    ...(process.platform === "win32"
      ? ["-ExecutionPolicy", "Bypass"]
      : []),
    "-File",
    path.join(rootDirectory, "scripts", "Manage-MyDashboard.ps1"),
    "-Action",
    action,
    "-TimeoutSeconds",
    "45",
  ];
  return spawnSync(executable, arguments_, {
    cwd: rootDirectory,
    encoding: "utf8",
    env: environment,
    timeout: 90_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function managedRuntimeInfo(rootDirectory, environment) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(rootDirectory, "scripts", "launch-mydashboard-process.mjs"),
      "--runtime-info",
    ],
    {
      cwd: rootDirectory,
      encoding: "utf8",
      env: environment,
      timeout: 10_000,
      windowsHide: true,
    },
  );
  assert.equal(
    result.status,
    0,
    `managed runtime identity failed:\n${diagnostic(result)}`,
  );
  return JSON.parse(result.stdout);
}

async function pollJson(
  url,
  timeoutMilliseconds = 45_000,
  accept = () => true,
  describeRejected = () => "",
  requestTimeoutMilliseconds = 2_000,
) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastFailure = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(requestTimeoutMilliseconds),
      });
      const text = await response.text();
      if (response.status === 200) {
        const body = JSON.parse(text);
        if (accept(body)) return { body, text };
        const description = describeRejected(body);
        lastFailure = "HTTP 200 response has not reached the required state" +
          (description ? `: ${description}` : "");
      } else {
        lastFailure = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastFailure = error?.name || "request failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`local server did not become ready: ${lastFailure}`);
}

async function waitUntilStopped(url, timeoutMilliseconds = 20_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("managed server still accepts connections after shutdown");
}

let distributionManifest;
let trackedFiles;
let trackedIndexEntries;

const trackedBlobModes = new Set(["100644", "100755", "120000"]);
const trackedPathDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

function runGitIn(
  repositoryRoot,
  arguments_,
  {
    encoding = arguments_.includes("-z") ? "buffer" : "utf8",
    input,
    timeout = 60_000,
    maxBuffer = 128 * 1024 * 1024,
  } = {},
) {
  return spawnSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding,
    ...(input === undefined ? {} : { input }),
    timeout,
    windowsHide: true,
    maxBuffer,
  });
}

function runGit(arguments_, timeout = 60_000) {
  return runGitIn(root, arguments_, { timeout });
}

function invalidTrackedIndex() {
  return new Error("invalid tracked Git index");
}

function parseTrackedIndexEntries(source) {
  if (!Buffer.isBuffer(source)) throw invalidTrackedIndex();
  const entries = [];
  const seenPaths = new Set();
  let offset = 0;
  while (offset < source.length) {
    const end = source.indexOf(0, offset);
    if (end < 0 || end === offset) throw invalidTrackedIndex();
    const record = source.subarray(offset, end);
    const separator = record.indexOf(9);
    if (separator <= 0 || separator === record.length - 1) {
      throw invalidTrackedIndex();
    }
    const metadata = record.subarray(0, separator).toString("ascii").match(
      /^H (100644|100755|120000|160000) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/u,
    );
    if (
      metadata === null ||
      metadata[3] !== "0" ||
      !trackedBlobModes.has(metadata[1])
    ) {
      throw invalidTrackedIndex();
    }
    let filePath;
    try {
      filePath = trackedPathDecoder.decode(record.subarray(separator + 1));
    } catch {
      throw invalidTrackedIndex();
    }
    if (
      filePath.length === 0 ||
      path.posix.isAbsolute(filePath) ||
      filePath.includes("\\") ||
      path.posix.normalize(filePath) !== filePath ||
      filePath === ".." ||
      filePath.startsWith("../") ||
      seenPaths.has(filePath)
    ) {
      throw invalidTrackedIndex();
    }
    seenPaths.add(filePath);
    entries.push({ mode: metadata[1], oid: metadata[2], filePath });
    offset = end + 1;
  }
  return entries;
}

function loadTrackedIndexEntries(repositoryRoot) {
  const listed = runGitIn(
    repositoryRoot,
    ["ls-files", "--stage", "-v", "-z"],
    { encoding: "buffer" },
  );
  assert.equal(listed.status, 0, "could not list tracked Git index");
  return parseTrackedIndexEntries(listed.stdout);
}

function parseBlobBatch(source, expectedObjectIds) {
  if (!Buffer.isBuffer(source)) throw new Error("invalid tracked Git object batch");
  const blobs = new Map();
  let offset = 0;
  for (const expectedObjectId of expectedObjectIds) {
    const headerEnd = source.indexOf(10, offset);
    if (headerEnd < 0) throw new Error("invalid tracked Git object batch");
    const header = source.subarray(offset, headerEnd).toString("ascii").match(
      /^([0-9a-f]{40}|[0-9a-f]{64}) blob ([0-9]+)$/u,
    );
    const size = header === null ? Number.NaN : Number(header[2]);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (
      header === null ||
      header[1] !== expectedObjectId ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      contentEnd >= source.length ||
      source[contentEnd] !== 10
    ) {
      throw new Error("invalid tracked Git object batch");
    }
    blobs.set(expectedObjectId, Buffer.from(source.subarray(contentStart, contentEnd)));
    offset = contentEnd + 1;
  }
  if (offset !== source.length) throw new Error("invalid tracked Git object batch");
  return blobs;
}

function readTrackedBlobs(repositoryRoot, entries) {
  const objectIds = [...new Set(entries.map(({ oid }) => oid))];
  if (objectIds.length === 0) return new Map();
  const read = runGitIn(repositoryRoot, ["cat-file", "--batch"], {
    encoding: "buffer",
    input: Buffer.from(`${objectIds.join("\n")}\n`, "ascii"),
  });
  assert.equal(read.status, 0, "could not read tracked Git objects");
  return parseBlobBatch(read.stdout, objectIds);
}

function loadTrackedFiles() {
  if (trackedFiles) return trackedFiles;
  trackedIndexEntries ||= loadTrackedIndexEntries(root);
  trackedFiles = new Set(trackedIndexEntries.map(({ filePath }) => filePath));
  return trackedFiles;
}

function loadDistributionManifest() {
  if (distributionManifest) return distributionManifest;
  const packed = runNpm(
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    root,
    60_000,
  );
  assert.equal(
    packed.status,
    0,
    `npm pack --dry-run failed:\n${diagnostic(packed)}`,
  );
  const report = JSON.parse(packed.stdout);
  assert.equal(report.length, 1);
  distributionManifest = report[0].files.map(({ path: filePath }) => filePath);
  return distributionManifest;
}

function assertPortablePackagePath(filePath) {
  assert.equal(path.posix.isAbsolute(filePath), false, filePath);
  assert.equal(filePath.includes("\\"), false, filePath);
  assert.equal(path.posix.normalize(filePath), filePath, filePath);
  assert.equal(filePath === ".." || filePath.startsWith("../"), false, filePath);
}

function localPath(rootDirectory, portablePath) {
  return path.join(rootDirectory, ...portablePath.split("/"));
}

const fakeCredentialMarkerPrefix = "PRIVACY_FAKE_CREDENTIAL_SHA256:";
const credentialPatterns = [
  new RegExp(`\\b${["gh", "p_"].join("")}[A-Za-z0-9]{30,}\\b`, "gu"),
  new RegExp(`\\b${["github", "_pat_"].join("")}[A-Za-z0-9_]{40,}\\b`, "gu"),
  new RegExp(`\\b${["sk", "-"].join("")}[A-Za-z0-9_-]{20,}\\b`, "gu"),
  new RegExp(`\\b${["AK", "IA"].join("")}[0-9A-Z]{16}\\b`, "gu"),
  new RegExp(`\\b${["AI", "za"].join("")}[0-9A-Za-z_-]{30,}\\b`, "gu"),
  new RegExp(`\\b${["xox", "b-"].join("")}[A-Za-z0-9-]{20,}\\b`, "gu"),
];
const userHomePatterns = [
  /[A-Za-z]:[\\/]Users[\\/](?!<(?:user|username)>)[^\\/\s"']+/giu,
  /\/Users\/(?!<(?:user|username)>)[^/\s"']+/giu,
  /\/home\/(?!<(?:user|username)>)[^/\s"']+/giu,
];
const quotedPersonalIdentifier = /(["'`])\d{12,20}\1/gu;
const pullRequestIdentity = /\b[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*#\d+\b/gu;

function normalizedComparableText(value) {
  return value.replaceAll("\\", "/").toLowerCase();
}

function isPortableRepositoryIdentity(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(
    value,
  );
}

function collectCandidateIdentityStrings(value, collected = []) {
  if (typeof value === "string") {
    collected.push(value);
    return collected;
  }
  if (value === null || typeof value !== "object") return collected;
  for (const [key, entry] of Object.entries(value)) {
    collected.push(key);
    collectCandidateIdentityStrings(entry, collected);
  }
  return collected;
}

async function optionalLocalPrivacyDenylist() {
  const denied = new Set([
    normalizedComparableText(root),
    ...[process.env.USERPROFILE, process.env.HOME]
      .filter(Boolean)
      .map(normalizedComparableText),
  ]);

  for (const fileName of ["config.json", "config.local.json"]) {
    try {
      const configuration = JSON.parse(await readFile(path.join(root, fileName), "utf8"));
      for (const value of collectCandidateIdentityStrings(configuration)) {
        if (path.isAbsolute(value) || isPortableRepositoryIdentity(value)) {
          denied.add(normalizedComparableText(value));
        }
      }
    } catch {
      // Missing or invalid private configuration never weakens credential scanning.
    }
  }

  try {
    const ledger = await readFile(
      path.join(
        root,
        ".superpowers",
        "sdd",
        "2026-08-02-001-feat-complete-command-center-plan",
        "owner-acceptance-gates.local.md",
      ),
      "utf8",
    );
    for (const match of ledger.matchAll(pullRequestIdentity)) {
      denied.add(normalizedComparableText(match[0]));
      denied.add(normalizedComparableText(match[0].split("#", 1)[0]));
    }
  } catch {
    // The owner-only local ledger is intentionally optional in public exports.
  }

  return denied;
}

function hasAdjacentFakeCredentialMarker(text, match, consumedMarkers) {
  const matchIndex = match.index;
  const currentLineStart = text.lastIndexOf("\n", matchIndex) + 1;
  if (currentLineStart === 0) return false;
  const previousLineEnd = currentLineStart - 1;
  const previousLineStart = text.lastIndexOf("\n", previousLineEnd - 1) + 1;
  const marker = text.slice(previousLineStart, previousLineEnd).trim().match(
    new RegExp(`^// ${fakeCredentialMarkerPrefix}([0-9a-f]{64})$`, "u"),
  );
  if (!marker || consumedMarkers.has(previousLineStart)) return false;
  const digest = createHash("sha256").update(match[0], "utf8").digest("hex");
  if (marker[1] !== digest) return false;
  consumedMarkers.add(previousLineStart);
  return true;
}

function assertSafePrivacyValue({
  value,
  denied,
  subject,
  credentialMatchIsAllowed = () => false,
}) {
  for (const pattern of credentialPatterns) {
    for (const match of value.matchAll(pattern)) {
      assert.equal(
        credentialMatchIsAllowed(match),
        true,
        `a ${subject} contains an unmarked credential-shaped value`,
      );
    }
  }
  for (const pattern of userHomePatterns) {
    assert.doesNotMatch(value, pattern, `a ${subject} contains a user-home path`);
  }
  assert.doesNotMatch(
    value,
    quotedPersonalIdentifier,
    `a ${subject} contains a quoted personal identifier`,
  );

  const comparableValue = normalizedComparableText(value);
  for (const identifier of denied) {
    assert.equal(
      comparableValue.includes(identifier),
      false,
      `a ${subject} contains a private local identity`,
    );
  }
}

function assertSafeTrackedText({ filePath, source, denied }) {
  if (source.includes(0)) {
    throw new Error("NUL-bearing tracked Git blob cannot be privacy-scanned");
  }
  assertSafePrivacyValue({
    value: filePath,
    denied,
    subject: "tracked path",
  });

  const text = source.toString("utf8");
  const consumedFakeCredentialMarkers = new Set();
  assertSafePrivacyValue({
    value: text,
    denied,
    subject: "tracked text file",
    credentialMatchIsAllowed: (match) =>
      filePath.startsWith("test/") &&
      hasAdjacentFakeCredentialMarker(
        text,
        match,
        consumedFakeCredentialMarkers,
      ),
  });
}

function assertSafeTrackedGitTree({
  repositoryRoot,
  denied,
  selectedPaths = null,
}) {
  const clean = runGitIn(
    repositoryRoot,
    ["diff", "--quiet", "HEAD", "--"],
  );
  assert.equal(clean.status, 0, "tracked content differs from HEAD");

  const entries = repositoryRoot === root && trackedIndexEntries
    ? trackedIndexEntries
    : loadTrackedIndexEntries(repositoryRoot);
  if (repositoryRoot === root) trackedIndexEntries = entries;
  const selected = selectedPaths === null ? null : new Set(selectedPaths);
  const scannedEntries = selected === null
    ? entries
    : entries.filter(({ filePath }) => selected.has(filePath));
  if (selected !== null && scannedEntries.length !== selected.size) {
    throw new Error("tracked privacy selection is incomplete");
  }
  const blobs = readTrackedBlobs(repositoryRoot, scannedEntries);
  for (const { filePath, oid } of scannedEntries) {
    const source = blobs.get(oid);
    if (!source) throw new Error("tracked Git object is unavailable");
    assertSafeTrackedText({ filePath, source, denied });
  }
}

async function materializeTrackedFiles({
  repositoryRoot,
  destinationRoot,
  filePaths,
}) {
  const selected = new Set(filePaths);
  const entries = repositoryRoot === root && trackedIndexEntries
    ? trackedIndexEntries
    : loadTrackedIndexEntries(repositoryRoot);
  if (repositoryRoot === root) trackedIndexEntries = entries;
  const selectedEntries = entries.filter(({ filePath }) =>
    selected.has(filePath)
  );
  if (selectedEntries.length !== selected.size) {
    throw new Error("clean-room tracked input selection is incomplete");
  }
  if (selectedEntries.some(({ mode }) => mode === "120000")) {
    throw new Error("clean-room inputs must be regular tracked files");
  }
  const blobs = readTrackedBlobs(repositoryRoot, selectedEntries);
  for (const { filePath, mode, oid } of selectedEntries) {
    const source = blobs.get(oid);
    if (!source) throw new Error("clean-room tracked object is unavailable");
    const destination = localPath(destinationRoot, filePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source, {
      mode: mode === "100755" ? 0o755 : 0o644,
    });
  }
}

test("clean manager environment excludes every spelling of the host Codex login root", () => {
  const { environment } = cleanManagerEnvironment("C:\\clean-room", {
    CODEX_HOME: "C:\\Users\\private-owner\\.codex",
    CoDeX_HoMe: "C:\\Users\\second-private-owner\\.codex",
    SAFE_PORTABLE_VALUE: "preserved",
  });

  assert.equal(
    Object.keys(environment).some((name) => name.toLowerCase() === "codex_home"),
    false,
  );
  assert.equal(environment.SAFE_PORTABLE_VALUE, "preserved");
});

test("clean manager environment excludes host GitHub CLI profile roots", () => {
  const environmentRoot = "C:\\clean-room";
  const { environment, directories } = cleanManagerEnvironment(environmentRoot, {
    APPDATA: "C:\\Users\\private-owner\\AppData\\Roaming",
    GH_CONFIG_DIR: "C:\\Users\\private-owner\\.config\\gh",
    SAFE_PORTABLE_VALUE: "preserved",
  });

  assert.equal(
    environment.APPDATA,
    path.join(environmentRoot, "clean-app-data"),
  );
  assert.equal(
    Object.keys(environment).some((name) => name.toLowerCase() === "gh_config_dir"),
    false,
  );
  assert.equal(
    directories.includes(path.join(environmentRoot, "clean-app-data")),
    true,
  );
  assert.equal(environment.SAFE_PORTABLE_VALUE, "preserved");
});

test("npm distribution contains the safe bootstrap and excludes local runtime state", () => {
  const files = loadDistributionManifest();
  const included = new Set(files);
  for (const filePath of files) assertPortablePackagePath(filePath);

  for (const required of [
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "SUPPORT.md",
    "config.example.json",
    "docs/ARCHITECTURE.md",
    "docs/OPERATIONS.md",
    "docs/PRIVACY.md",
    "docs/PROJECT_STATUS.md",
    "docs/USER_GUIDE.zh-CN.md",
    "npm-shrinkwrap.json",
    "package.json",
    "README.md",
    "scripts/Manage-MyDashboard.ps1",
    "scripts/probe-application-writer-lease.mjs",
    "scripts/verify-codex-login-readiness.mjs",
    "src/lib/config.js",
    "src/lib/windows-codex-credential-helper.ps1",
    "src/server.js",
    "src/skills/quick-pr-review/SKILL.md",
  ]) {
    assert.equal(included.has(required), true, `missing ${required}`);
  }

  for (const filePath of files) {
    assert.doesNotMatch(
      filePath,
      /(?:^|\/)(?:auth\.json|hosts\.yml|\.codex|\.config\/gh|\.mydashboard-cli-credentials-v1|github-credentials-v1)(?:\/|$)/u,
      `packaged credential material ${filePath}`,
    );
  }

  for (const forbidden of [
    "config.json",
    "config.local.json",
    ".env",
    ".env.local",
    "DEVELOPMENT_PLAN.md",
    "validation-notes.md",
  ]) {
    assert.equal(
      included.has(forbidden),
      false,
      `packaged private file ${forbidden}`,
    );
  }

  for (const filePath of files) {
    assert.doesNotMatch(
      filePath,
      /^(?:data|logs|backups|restore-control|validation-artifacts|node_modules|\.review-runs|playwright-report|test-results|test|test-support|docs\/(?:plans|reviews))(?:\/|$)/u,
    );
  }
});

test("packed manager resolves the packaged writer lease probe in a clean runtime", async (context) => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "mydashboard-packed-manager-"),
  );
  context.after(async () => {
    assert.equal(path.dirname(fixtureRoot), path.resolve(tmpdir()));
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  const packRoot = path.join(fixtureRoot, "pack");
  const installRoot = path.join(fixtureRoot, "install");
  const environmentRoot = path.join(fixtureRoot, "environment");
  await Promise.all([
    mkdir(packRoot, { recursive: true }),
    mkdir(installRoot, { recursive: true }),
    mkdir(environmentRoot, { recursive: true, mode: 0o700 }),
  ]);

  const packed = runNpm(
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packRoot],
    root,
    60_000,
  );
  assert.equal(packed.status, 0, `npm pack failed:\n${diagnostic(packed)}`);
  const [{ filename }] = JSON.parse(packed.stdout);
  const tarball = path.join(packRoot, filename);
  await writeFile(
    path.join(installRoot, "package.json"),
    '{"name":"packed-manager-fixture","private":true}\n',
  );
  const installed = runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    installRoot,
    60_000,
  );
  assert.equal(
    installed.status,
    0,
    `packed manager install failed:\n${diagnostic(installed)}`,
  );

  const packageRoot = path.join(
    installRoot,
    "node_modules",
    "dev-intelligence-hub",
  );
  assert.equal(
    existsSync(path.join(packageRoot, "scripts", "Manage-MyDashboard.ps1")),
    true,
  );
  assert.equal(
    existsSync(path.join(packageRoot, "scripts", "probe-application-writer-lease.mjs")),
    true,
  );
  await writeFile(
    path.join(packageRoot, "config.json"),
    `${JSON.stringify({ port: await availablePort() })}\n`,
    { mode: 0o600 },
  );

  const powershell = managerPowerShell();
  if (powershell === null) {
    context.skip("requires PowerShell manager availability");
    return;
  }
  protectWindowsFixtureDirectory(environmentRoot, powershell);
  const { environment, directories } = cleanManagerEnvironment(environmentRoot);
  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const status = runManager({
    executable: powershell,
    rootDirectory: packageRoot,
    environment,
    action: "Status",
  });
  assert.equal(
    status.status,
    3,
    `packed manager could not resolve its helper:\n${diagnostic(status)}`,
  );
  assert.match(status.stdout, /stopped/iu);
});

test("brokered Codex login examples and public guidance agree with the runtime", () => {
  const example = JSON.parse(
    readFileSync(path.join(root, "config.example.json"), "utf8"),
  );
  assert.equal(
    example.brainProviders["codex-local-cli"].credentialMode,
    "codex-login",
  );
  assert.equal(
    example.brainProviders["claude-local-cli"].credentialMode,
    "api-key",
  );

  const documents = Object.fromEntries(
    [
      "README.md",
      "SECURITY.md",
      "docs/ARCHITECTURE.md",
      "docs/OPERATIONS.md",
      "docs/PRIVACY.md",
    ].map((filePath) => [
      filePath,
      readFileSync(path.join(root, filePath), "utf8"),
    ]),
  );
  const guidance = Object.values(documents).join("\n");
  for (const [filePath, contents] of Object.entries(documents)) {
    assert.match(contents, /codex-login/u, `${filePath} omits brokered login`);
  }
  assert.match(
    documents["docs/OPERATIONS.md"],
    /node scripts\/verify-codex-login-readiness\.mjs --origin http:\/\/127\.0\.0\.1:4173/u,
  );
  for (const expected of [
    /credentialMode.*codex-login/isu,
    /same Windows user|同一 Windows 用户/iu,
    /file_login_unavailable/u,
    /unsafe_source/u,
    /broker_blocked/u,
    /cli_unavailable/u,
    /serial|串行/iu,
    /keyring/iu,
    /logout|退出登录/iu,
    /API-key|API Key/iu,
    /backup|备份/iu,
    /restart|重启/iu,
  ]) {
    assert.match(guidance, expected);
  }
  assert.doesNotMatch(
    documents["README.md"],
    /CLI 不复用宿主机已经登录的 Codex\/Claude/iu,
  );
  assert.doesNotMatch(
    documents["docs/OPERATIONS.md"],
    /Codex CLI reads only `OPENAI_API_KEY`/u,
  );
  assert.doesNotMatch(
    documents["docs/PRIVACY.md"],
    /MyDashboard uses only the\s+fixed `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`/u,
  );
});

test("brokered GitHub CLI login examples and public guidance agree with the runtime", () => {
  const example = JSON.parse(
    readFileSync(path.join(root, "config.example.json"), "utf8"),
  );
  assert.equal(example.githubActions.credentialMode, "gh-login");
  assert.equal(Object.hasOwn(example.githubActions, "tokenEnv"), false);

  const documents = Object.fromEntries(
    [
      "README.md",
      "SECURITY.md",
      "docs/ARCHITECTURE.md",
      "docs/OPERATIONS.md",
      "docs/PRIVACY.md",
    ].map((filePath) => [
      filePath,
      readFileSync(path.join(root, filePath), "utf8"),
    ]),
  );
  const guidance = Object.values(documents).join("\n");
  for (const [filePath, contents] of Object.entries(documents)) {
    assert.match(contents, /gh-login/u, `${filePath} omits GitHub CLI login`);
  }
  for (const expected of [
    /credentialMode.*gh-login/isu,
    /GitHub CLI 当前登录|current GitHub CLI login/iu,
    /actorAccountId/u,
    /token-env/u,
    /confirm|确认/iu,
    /memory|内存/iu,
    /persist|持久/iu,
    /physical memory|物理内存/iu,
    /account mismatch|账号不一致|错误账号/iu,
    /cleanup|清理/iu,
  ]) {
    assert.match(guidance, expected);
  }
});

test("GitHub login guidance locates profile and actor verification at the real boundaries", () => {
  const readDocument = (filePath) =>
    readFileSync(path.join(root, filePath), "utf8");
  const readme = readDocument("README.md");
  const operations = readDocument("docs/OPERATIONS.md");
  const privacy = readDocument("docs/PRIVACY.md");

  assert.match(
    operations,
    /transport[\s\S]{0,240}(?:GET\s+`?\/user`?|account)[\s\S]{0,240}(?:before|prior to)[\s\S]{0,80}(?:write|mutation)/iu,
  );
  assert.doesNotMatch(
    operations,
    /verifies the requested account before exposing[\s\S]{0,120}GitHub transport/iu,
  );
  for (const contents of [readme, privacy]) {
    assert.match(contents, /不直接解析|does not directly parse/iu);
    assert.match(
      contents,
      /(?:固定|fixed)[\s\S]{0,80}(?:`gh\.exe`|GitHub CLI)[\s\S]{0,160}(?:默认|default)[\s\S]{0,80}profile/iu,
    );
    assert.doesNotMatch(
      contents,
      /(?:系统不读取|MyDashboard does not read)[^\n.]{0,120}`hosts\.yml`/iu,
    );
  }
});

test("Apache-2.0 distribution identity rejects missing, corrupt, inconsistent, or unpackaged license artifacts", () => {
  const licensePath = path.join(root, "LICENSE");
  assert.equal(existsSync(licensePath), true, "missing root LICENSE");

  const license = Buffer.from(
    readFileSync(licensePath, "utf8")
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n"),
    "utf8",
  );
  assert.equal(
    license.length,
    11_358,
    "root LICENSE has an unexpected byte length",
  );
  assert.equal(
    createHash("sha256").update(license).digest("hex"),
    "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
    "root LICENSE differs from the canonical Apache License 2.0 text",
  );

  const packageManifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const packageLock = JSON.parse(
    readFileSync(path.join(root, "package-lock.json"), "utf8"),
  );
  const shrinkwrap = JSON.parse(
    readFileSync(path.join(root, "npm-shrinkwrap.json"), "utf8"),
  );
  for (const [artifact, manifest] of [
    ["package.json", packageManifest],
    ["package-lock.json", packageLock.packages[""]],
    ["npm-shrinkwrap.json", shrinkwrap.packages[""]],
  ]) {
    assert.equal(
      manifest.license,
      "Apache-2.0",
      `${artifact} has the wrong SPDX license`,
    );
  }

  assert.equal(
    readFileSync(path.join(root, "package-lock.json")).equals(
      readFileSync(path.join(root, "npm-shrinkwrap.json")),
    ),
    true,
    "published shrinkwrap differs from the source-checkout lock",
  );
  assert.equal(
    new Set(loadDistributionManifest()).has("LICENSE"),
    true,
    "npm payload omits LICENSE",
  );
});

test("distribution and clean-room inputs come only from the committed tree", () => {
  const sourceFiles = new Set(loadDistributionManifest());
  const tracked = loadTrackedFiles();
  for (const filePath of sourceFiles) {
    assert.equal(tracked.has(filePath), true, `untracked release input ${filePath}`);
  }
  assert.equal(tracked.has("package-lock.json"), true);

  const dirty = runGit([
    "diff",
    "--quiet",
    "HEAD",
    "--",
    ...sourceFiles,
    "package-lock.json",
  ]);
  assert.equal(
    dirty.status,
    0,
    "release inputs differ from HEAD; commit them before clean-room acceptance",
  );
  assert.equal(
    readFileSync(path.join(root, "npm-shrinkwrap.json")).equals(
      readFileSync(path.join(root, "package-lock.json")),
    ),
    true,
    "published shrinkwrap differs from the source-checkout lock",
  );
});

test("distributable text contains no high-confidence live credential or private machine path", async () => {
  assertSafeTrackedGitTree({
    repositoryRoot: root,
    denied: await optionalLocalPrivacyDenylist(),
    selectedPaths: loadDistributionManifest(),
  });
});

test("whole tracked Git tree contains no private identifiers or credentials", async () => {
  assertSafeTrackedGitTree({
    repositoryRoot: root,
    denied: await optionalLocalPrivacyDenylist(),
  });
});

test("privacy scanner rejects unmarked synthetic credentials and permits marked test fixtures", () => {
  const syntheticCredential = ["sk", "live", "synthetic", "credential", "only", "for", "scanner"].join("-");
  const secondSyntheticCredential = ["sk", "live", "second", "synthetic", "credential", "for", "scanner"].join("-");
  const syntheticCredentialMarker = `${fakeCredentialMarkerPrefix}11c972c4d7167c096da8aa045a157509a7f04cf84e340ff809b230908f25e422`;
  const denied = new Set();
  assert.throws(
    () =>
      assertSafeTrackedText({
        filePath: "test/unmarked-fixture.test.js",
        source: Buffer.from(`const value = \"${syntheticCredential}\";`),
        denied,
      }),
    /unmarked credential-shaped value/u,
  );
  assert.doesNotThrow(() =>
    assertSafeTrackedText({
      filePath: "test/marked-fixture.test.js",
      source: Buffer.from(
        `// ${syntheticCredentialMarker}\nconst value = \"${syntheticCredential}\";`,
      ),
      denied,
    }),
  );
  assert.throws(
    () =>
      assertSafeTrackedText({
        filePath: "test/marked-plus-unmarked-fixture.test.js",
        source: Buffer.from(
          `// ${syntheticCredentialMarker}\nconst first = \"${syntheticCredential}\"; const second = \"${secondSyntheticCredential}\";`,
        ),
        denied,
      }),
    /unmarked credential-shaped value/u,
  );
  assert.throws(
    () =>
      assertSafeTrackedText({
        filePath: "test/non-adjacent-fixture.test.js",
        source: Buffer.from(
          `// ${syntheticCredentialMarker}\n\nconst value = \"${syntheticCredential}\";`,
        ),
        denied,
      }),
    /unmarked credential-shaped value/u,
  );
});

test("whole tracked privacy fails closed for NUL-bearing blobs", () => {
  const syntheticCredential = [
    "sk",
    "utf16",
    "credential",
    "must",
    "not",
    "bypass",
    "privacy",
  ].join("-");

  assert.throws(
    () =>
      assertSafeTrackedText({
        filePath: "docs/encoded-credential.md",
        source: Buffer.from(syntheticCredential, "utf16le"),
        denied: new Set(),
      }),
    /NUL-bearing tracked Git blob cannot be privacy-scanned/u,
  );
});

test("whole tracked privacy applies the same policy to tracked path names", () => {
  const syntheticCredential = [
    "sk",
    "path",
    "credential",
    "must",
    "not",
    "bypass",
    "privacy",
  ].join("-");
  const deniedRepositoryIdentity = [
    "private-owner",
    "private-repository",
  ].join("/");
  const fixtures = [
    {
      filePath: `docs/${syntheticCredential}.md`,
      denied: new Set(),
      expected: /tracked path contains an unmarked credential-shaped value/u,
    },
    {
      filePath: `${deniedRepositoryIdentity}/notes.md`,
      denied: new Set([deniedRepositoryIdentity]),
      expected: /tracked path contains a private local identity/u,
    },
  ];

  for (const fixture of fixtures) {
    assert.throws(
      () =>
        assertSafeTrackedText({
          filePath: fixture.filePath,
          source: Buffer.from("portable safe body\n"),
          denied: fixture.denied,
        }),
      fixture.expected,
    );
  }
});

test("tracked index parsing rejects unsafe metadata and path encoding", () => {
  const oid = "a".repeat(40);
  assert.deepEqual(
    parseTrackedIndexEntries(Buffer.from(`H 100644 ${oid} 0\ttest/safe.js\0`)),
    [{ mode: "100644", oid, filePath: "test/safe.js" }],
  );
  const bomPath = Buffer.concat([
    Buffer.from(`H 100644 ${oid} 0\t`),
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("test/not-a-test-fixture.js\0"),
  ]);
  const [decodedBomPath] = parseTrackedIndexEntries(bomPath);
  assert.equal(decodedBomPath.filePath, "\ufefftest/not-a-test-fixture.js");
  assert.equal(decodedBomPath.filePath.startsWith("test/"), false);

  for (const source of [
    Buffer.from(`H 100644 ${oid} 1\ttest/conflicted.js\0`),
    Buffer.from(`H 160000 ${oid} 0\tunsupported-submodule\0`),
    Buffer.from(`S 100644 ${oid} 0\tskip-worktree.js\0`),
    Buffer.from(`h 100644 ${oid} 0\tassume-unchanged.js\0`),
    Buffer.from(`H 100644 ${"a".repeat(39)} 0\tinvalid-object-id\0`),
    Buffer.concat([
      Buffer.from(`H 100644 ${oid} 0\tinvalid-`),
      Buffer.from([0xff, 0]),
    ]),
  ]) {
    assert.throws(
      () => parseTrackedIndexEntries(source),
      /invalid tracked Git index/u,
    );
  }
});

test("tracked symlink privacy scans its Git blob without reading an external target", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "privacy-git-fixture-"));
  const externalRoot = await mkdtemp(
    path.join(tmpdir(), "privacy-external-fixture-"),
  );
  context.after(async () => {
    assert.equal(path.dirname(fixtureRoot), path.resolve(tmpdir()));
    assert.equal(path.dirname(externalRoot), path.resolve(tmpdir()));
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  });

  const syntheticCredential = [
    "sk",
    "symlink",
    "blob",
    "must",
    "be",
    "scanned",
  ].join("-");
  const externalFile = path.join(externalRoot, syntheticCredential);
  const externalTarget = path.relative(fixtureRoot, externalFile)
    .replaceAll("\\", "/");
  await writeFile(externalFile, "safe external target content\n");

  for (const arguments_ of [
    ["init", "--quiet"],
    ["config", "user.name", "Privacy Fixture"],
    ["config", "user.email", "privacy-fixture@example.invalid"],
  ]) {
    const result = spawnSync("git", arguments_, {
      cwd: fixtureRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, "synthetic Git fixture setup failed");
  }
  const stored = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: fixtureRoot,
    input: Buffer.from(externalTarget, "utf8"),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(stored.status, 0, "synthetic symlink blob creation failed");
  const symlinkOid = stored.stdout.trim();
  assert.match(symlinkOid, /^[0-9a-f]{40,64}$/u);
  for (const arguments_ of [
    ["update-index", "--add", "--cacheinfo", `120000,${symlinkOid},tracked-link`],
    ["commit", "--quiet", "-m", "synthetic symlink fixture"],
  ]) {
    const result = spawnSync("git", arguments_, {
      cwd: fixtureRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, "synthetic Git fixture setup failed");
  }
  const trackedLink = path.join(fixtureRoot, "tracked-link");
  await symlink(
    externalRoot,
    trackedLink,
    process.platform === "win32" ? "junction" : "dir",
  );
  const entries = loadTrackedIndexEntries(fixtureRoot);
  const blobs = readTrackedBlobs(fixtureRoot, entries);
  const link = entries.find(({ filePath }) => filePath === "tracked-link");
  assert.ok(link);
  assert.throws(
    () =>
      assertSafeTrackedText({
        filePath: link.filePath,
        source: blobs.get(link.oid),
        denied: new Set(),
      }),
    /unmarked credential-shaped value/u,
  );
  const cleanOutput = path.join(fixtureRoot, "clean-output");
  await assert.rejects(
    materializeTrackedFiles({
      repositoryRoot: fixtureRoot,
      destinationRoot: cleanOutput,
      filePaths: ["tracked-link"],
    }),
    /regular tracked files/u,
  );
  assert.equal(existsSync(path.join(cleanOutput, "tracked-link")), false);
  assert.equal(
    await readFile(externalFile, "utf8"),
    "safe external target content\n",
  );
});

test("whole tracked Git privacy fails closed for dirty tracked content", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "privacy-dirty-fixture-"));
  context.after(async () => {
    assert.equal(path.dirname(fixtureRoot), path.resolve(tmpdir()));
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  for (const arguments_ of [
    ["init", "--quiet"],
    ["config", "user.name", "Privacy Fixture"],
    ["config", "user.email", "privacy-fixture@example.invalid"],
  ]) {
    const result = spawnSync("git", arguments_, {
      cwd: fixtureRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, "synthetic Git fixture setup failed");
  }
  await writeFile(path.join(fixtureRoot, "tracked.txt"), "safe content\n");
  for (const arguments_ of [
    ["add", "tracked.txt"],
    ["commit", "--quiet", "-m", "synthetic clean fixture"],
  ]) {
    const result = spawnSync("git", arguments_, {
      cwd: fixtureRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, "synthetic Git fixture setup failed");
  }
  const dirtyCredential = [
    "sk",
    "dirty",
    "tracked",
    "content",
    "must",
    "not",
    "bypass",
  ].join("-");
  await writeFile(
    path.join(fixtureRoot, "tracked.txt"),
    `${dirtyCredential}\n`,
  );

  assert.throws(
    () =>
      assertSafeTrackedGitTree({
        repositoryRoot: fixtureRoot,
        denied: new Set(),
      }),
    /tracked content differs from HEAD/u,
  );
});

test(
  "a clean source payload installs and composes without private config.json",
  async (context) => {
    const environmentFixtureRoot = await mkdtemp(
      path.join(tmpdir(), "mydashboard-clean-environment-"),
    );
    const sourceFixtureRoot = await mkdtemp(
      path.join(path.dirname(root), ".mydashboard-clean-source-"),
    );
    const cleanRoot = path.join(sourceFixtureRoot, "source");
    const environmentRoot = path.join(
      environmentFixtureRoot,
      "environment",
    );
    let fallbackStop = null;
    let managedProcessId = null;
    let managedLiveUrl = null;
    context.after(async () => {
      if (fallbackStop) {
        const stopped = fallbackStop();
        if (
          stopped.status !== 0 &&
          Number.isInteger(managedProcessId) &&
          managedProcessId > 0
        ) {
          try {
            process.kill(managedProcessId);
            await waitUntilStopped(managedLiveUrl, 5_000);
          } catch {
            // The exact managed fixture process is already gone.
          }
        }
      }
      assert.equal(
        path.dirname(environmentFixtureRoot),
        path.resolve(tmpdir()),
      );
      assert.equal(path.dirname(sourceFixtureRoot), path.dirname(root));
      await Promise.all([
        rm(environmentFixtureRoot, { recursive: true, force: true }),
        rm(sourceFixtureRoot, { recursive: true, force: true }),
      ]);
    });

    const sourceFiles = new Set(loadDistributionManifest());
    for (const filePath of sourceFiles) {
      assertPortablePackagePath(filePath);
    }
    await materializeTrackedFiles({
      repositoryRoot: root,
      destinationRoot: cleanRoot,
      filePaths: sourceFiles,
    });

    assert.equal(existsSync(path.join(cleanRoot, "config.json")), false);
    assert.equal(existsSync(path.join(cleanRoot, "config.local.json")), false);

    const installed = runNpm(
      [
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
      ],
      cleanRoot,
    );
    assert.equal(
      installed.status,
      0,
      `clean npm ci failed:\n${diagnostic(installed)}`,
    );

    const probeSource = [
      'import { loadConfigBootstrap } from "./src/lib/config.js";',
      'import { normalizeConfigurationDocument } from "./src/domain/configuration-contract.js";',
      // Import the executable module too: its dependency graph must be loadable in
      // a clean checkout, while its main guard keeps this probe side-effect free.
      'await import("./src/server.js");',
      "const bootstrap = await loadConfigBootstrap();",
      "if (bootstrap.bootstrapError !== null) throw new Error('bootstrap error');",
      "const configuration = normalizeConfigurationDocument(bootstrap.candidate);",
      "if (configuration.codeExecutor.enabled !== false) throw new Error('executor enabled');",
      "if (configuration.githubActions.enabled !== false) throw new Error('actions enabled');",
      "if (configuration.memory.enabled !== false) throw new Error('memory enabled');",
      "process.stdout.write('SAFE_BOOTSTRAP_OK');",
    ].join("\n");
    const probed = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", probeSource],
      {
        cwd: cleanRoot,
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    assert.equal(
      probed.status,
      0,
      `clean safe-bootstrap probe failed:\n${diagnostic(probed)}`,
    );
    assert.equal(probed.stdout, "SAFE_BOOTSTRAP_OK");

    const powershell = managerPowerShell();
    if (process.platform === "win32") {
      assert.notEqual(
        powershell,
        null,
        "Windows release validation requires PowerShell for managed-start verification",
      );
    }
    await context.test(
      "the clean payload starts, reports status, and stops through its trusted manager",
      {
        skip: process.platform !== "win32" && powershell === null
          ? "requires PowerShell manager availability"
          : false,
      },
      async () => {
        const port = await availablePort();
        const examplePath = path.join(cleanRoot, "config.example.json");
        const example = JSON.parse(await readFile(examplePath, "utf8"));
        example.port = port;
        await writeFile(examplePath, `${JSON.stringify(example, null, 2)}\n`);

        const { environment, directories } = cleanManagerEnvironment(
          environmentRoot,
        );
        await mkdir(environmentRoot, { recursive: true, mode: 0o700 });
        protectWindowsFixtureDirectory(environmentRoot, powershell);
        for (const directory of directories) {
          await mkdir(directory, { recursive: true, mode: 0o700 });
        }
        const managerOptions = {
          executable: powershell,
          rootDirectory: cleanRoot,
          environment,
        };
        const runtimeInfo = managedRuntimeInfo(cleanRoot, environment);
        const started = runManager({ ...managerOptions, action: "Start" });
        const managedLog = started.status === 0
          ? ""
          : await readFile(
              path.join(runtimeInfo.runtimeDirectory, "logs", "server.log"),
              "utf8",
            ).catch(() => "<managed log unavailable>");
        assert.equal(
          started.status,
          0,
          `clean managed start failed:\n${diagnostic(started)}\n${managedLog.slice(-maximumDiagnosticCharacters)}`,
        );
        fallbackStop = () =>
          runManager({ ...managerOptions, action: "Stop" });

        managedLiveUrl = `http://127.0.0.1:${port}/api/live`;
        const live = await pollJson(managedLiveUrl);
        assert.equal(live.body.schemaVersion, 1);
        assert.equal(live.body.live, true);
        assert.equal(live.body.service, "mydashboard");
        assert.equal(live.body.managed, true);
        assert.equal(live.body.lifecycleState, "running");
        assert.equal(Number.isInteger(live.body.processId), true);
        managedProcessId = live.body.processId;

        const status = await pollJson(
          `http://127.0.0.1:${port}/api/system/status`,
          45_000,
          (body) => body?.readiness?.ready === true,
          (body) => JSON.stringify({
            ready: body?.readiness?.ready,
            recoveryBlockers: body?.readiness?.recoveryBlockers,
            unknownExternalActions: body?.readiness?.unknownExternalActions,
            capacityWarnings: body?.readiness?.capacityWarnings,
            probeFailures: body?.readiness?.probeFailures,
            probeSummary: body?.readiness?.probeSummary,
          }),
        );
        assert.equal(status.body.liveness.live, true);
        assert.equal(status.body.readiness.schemaVersion, 1);
        assert.equal(status.body.maintenance.mode, "open");
        assert.equal(Array.isArray(status.body.backups.items), true);

        const brainStatus = await pollJson(
          `http://127.0.0.1:${port}/api/brain-providers/status`,
          // Allow one bounded status operation (180 s) and its cleanup (30 s).
          // Aborting/retrying at 30 s can repeatedly cancel credential staging.
          210_000,
          () => true,
          () => "",
          210_000,
        );
        assert.equal(brainStatus.body.schemaVersion, 1);
        assert.equal(
          brainStatus.body.state,
          process.platform === "win32"
            ? "file_login_unavailable"
            : "cli_unavailable",
        );
        assert.equal(brainStatus.body.fileLoginAvailable, false);

        const dashboard = await pollJson(
          `http://127.0.0.1:${port}/api/dashboard`,
        );
        assert.deepEqual(dashboard.body.meta.errors, []);
        assert.equal(dashboard.body.meta.sources.github, 0);

        const managedStatus = runManager({ ...managerOptions, action: "Status" });
        assert.equal(
          managedStatus.status,
          0,
          `clean managed status failed:\n${diagnostic(managedStatus)}`,
        );
        assert.match(managedStatus.stdout, new RegExp(`PID ${managedProcessId}`));

        const responseText = `${live.text}\n${status.text}\n${dashboard.text}\n${brainStatus.text}`.toLowerCase();
        for (const privatePath of [
          cleanRoot,
          root,
          process.env.USERPROFILE,
          process.env.HOME,
        ].filter(Boolean)) {
          for (const spelling of [
            privatePath,
            privatePath.replaceAll("\\", "/"),
            privatePath.replaceAll("/", "\\"),
          ]) {
            assert.equal(responseText.includes(spelling.toLowerCase()), false);
          }
        }

        const stopped = fallbackStop();
        assert.equal(
          stopped.status,
          0,
          `clean managed stop failed:\n${diagnostic(stopped)}`,
        );
        assert.match(stopped.stdout, /stopped gracefully/iu);
        fallbackStop = null;
        await waitUntilStopped(managedLiveUrl);
      },
    );
  },
);
