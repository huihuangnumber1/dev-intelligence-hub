import { parseJsonWithUniqueKeys } from "../src/lib/strict-json.js";

const maximumBodyBytes = 16 * 1024;
const requestTimeoutMs = 90_000;
const failureMarker = "CODEX_LOGIN_READINESS_FAILED\n";
const capabilities = new Map([
  ["available", Object.freeze({ cliAvailable: true, fileLoginAvailable: true })],
  [
    "file_login_unavailable",
    Object.freeze({ cliAvailable: true, fileLoginAvailable: false }),
  ],
  ["unsafe_source", Object.freeze({ cliAvailable: true, fileLoginAvailable: false })],
  ["broker_blocked", Object.freeze({ cliAvailable: true, fileLoginAvailable: false })],
  ["cli_unavailable", Object.freeze({ cliAvailable: false, fileLoginAvailable: false })],
]);

function originFromArguments(arguments_) {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--origin" ||
    typeof arguments_[1] !== "string"
  ) {
    throw new Error("invalid arguments");
  }
  const match = arguments_[1].match(
    /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/u,
  );
  const port = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("invalid origin");
  }
  return new URL(arguments_[1]).origin;
}

async function boundedResponseText(response) {
  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new Error("invalid content type");
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (
      !/^(?:0|[1-9][0-9]*)$/u.test(declaredLength) ||
      Number(declaredLength) > maximumBodyBytes
    )
  ) {
    throw new Error("invalid content length");
  }
  if (response.body === null) throw new Error("missing response body");

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("invalid response body");
      total += value.byteLength;
      if (total > maximumBodyBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("response body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function readinessStatus(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("invalid status");
  }
  const fields = Object.keys(value).sort();
  const expectedFields = ["cliAvailable", "fileLoginAvailable", "schemaVersion", "state"];
  if (Object.hasOwn(value, "credentialMode")) expectedFields.push("credentialMode");
  if (
    fields.join("\0") !== expectedFields.sort().join("\0")
  ) {
    throw new Error("invalid status fields");
  }
  const expected = capabilities.get(value.state);
  if (
    value.schemaVersion !== 1 ||
    (Object.hasOwn(value, "credentialMode") && value.credentialMode !== "codex-native-login") ||
    expected === undefined ||
    value.cliAvailable !== expected.cliAvailable ||
    value.fileLoginAvailable !== expected.fileLoginAvailable
  ) {
    throw new Error("invalid status value");
  }
  return value.state;
}

async function verify() {
  const origin = originFromArguments(process.argv.slice(2));
  const response = await fetch(`${origin}/api/brain-providers/status`, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (response.status !== 200) throw new Error("readiness request failed");
  const text = await boundedResponseText(response);
  const state = readinessStatus(parseJsonWithUniqueKeys(text));
  process.stdout.write(`CODEX_LOGIN_READINESS_OK state=${state}\n`);
}

try {
  await verify();
} catch {
  process.exitCode = 1;
  process.stderr.write(failureMarker);
}
