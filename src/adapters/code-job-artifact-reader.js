import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { beginCodeReadSession, describeCodeReadContext, pageCodeReadText } from "../lib/code-read-context.js";

const MANIFEST = "code-read-manifest.json";
const integer = { type: "integer", minimum: 0 };
const length = { type: "integer", minimum: 1, maximum: 48_000 };
const revision = { type: "string", enum: ["current"] };
const TOOLS = [
  { name: "read_document", description: "Read code-read-manifest.json. Source files use read_source. Offsets are UTF-16 code units; follow nextOffset until null.",
    inputSchema: { type: "object", required: ["document", "offset"], additionalProperties: false,
      properties: { document: { type: "string", enum: [MANIFEST] }, offset: integer, length } } },
  { name: "read_source", description: "Read an immutable audited source file from this job's current workspace version. Follow nextOffset until null to read the entire file. Offsets are UTF-16 code units, paths are repository-relative.",
    inputSchema: { type: "object", required: ["path", "offset"], additionalProperties: false,
      properties: { path: { type: "string" }, offset: integer, length, revision } } },
  { name: "list_directory", description: "List only audited source documents available to this invocation; this does not inspect the host filesystem. Use an empty path for the repository root.",
    inputSchema: { type: "object", required: ["path"], additionalProperties: false,
      properties: { path: { type: "string" }, revision } } },
].map((tool) => ({ ...tool, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }));

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function argumentsFor(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw failure("CODE_READ_ARGUMENT_INVALID");
  }
  if (Object.hasOwn(value, "revision") && value.revision !== "current") throw failure("CODE_READ_REVISION_INVALID");
  return value;
}

function directoryEntries(documents, path) {
  if (typeof path !== "string" || /[\\:\u0000-\u001f\u007f]/u.test(path) ||
      (path !== "" && path.split("/").some((part) => !part || part === "." || part === ".."))) {
    throw failure("CODE_READ_PATH_INVALID");
  }
  const prefix = path ? `${path}/` : "";
  const entries = new Map();
  for (const document of documents) {
    if (!document.path.startsWith(prefix)) continue;
    const remainder = document.path.slice(prefix.length);
    const [name, ...nested] = remainder.split("/");
    const entryPath = `${prefix}${name}`;
    entries.set(entryPath, { path: entryPath, type: nested.length ? "dir" : "file" });
  }
  if (path && !entries.size) throw failure("CODE_READ_DOCUMENT_NOT_FOUND");
  return { entries: [...entries.values()] };
}

// This endpoint has no filesystem or GitHub access. The capability contains
// only source text already verified against the controlled executor's audit.
export async function createCodeJobArtifactReader(context, { signal = null } = {}) {
  const documents = describeCodeReadContext(context).documents;
  const manifestText = JSON.stringify({ documents }, null, 2);
  const session = beginCodeReadSession(context, { signal });
  const endpointPath = `/code-read/${randomBytes(32).toString("hex")}`;
  let closing;
  let closed = false;
  const callTool = (name, rawArguments) => {
    if (closed || signal?.aborted) throw failure("CODE_READ_SESSION_REVOKED");
    session.assertActive();
    if (name === "read_document") {
      const args = argumentsFor(rawArguments, ["document", "offset"], ["length"]);
      if (args.document !== MANIFEST) throw failure("CODE_READ_DOCUMENT_NOT_FOUND");
      return pageCodeReadText(manifestText, { document: MANIFEST }, args.offset, args.length);
    }
    if (name === "read_source") {
      const args = argumentsFor(rawArguments, ["path", "offset"], ["length", "revision"]);
      return session.readDocument(args.path, args.offset, args.length);
    }
    if (name === "list_directory") {
      const args = argumentsFor(rawArguments, ["path"], ["revision"]);
      return directoryEntries(session.listDocuments(), args.path);
    }
    throw failure("CODE_READ_TOOL_NOT_ALLOWED");
  };
  const server = createServer(async (request, response) => {
    if (request.url !== endpointPath || request.headers.origin !== undefined || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    let message;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 64 * 1024) throw failure("CODE_READ_ARGUMENT_INVALID");
        chunks.push(chunk);
      }
      message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
        throw failure("CODE_READ_ARGUMENT_INVALID");
      }
      if (!Object.hasOwn(message, "id")) { response.writeHead(202).end(); return; }
      let result;
      if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mydashboard-code-artifacts", version: "1.0.0" } };
      else if (message.method === "ping") result = {};
      else if (message.method === "tools/list") result = { tools: TOOLS };
      else if (message.method === "tools/call") {
        try {
          const value = callTool(message.params?.name, message.params?.arguments);
          result = { content: [{ type: "text", text: JSON.stringify(value) }] };
        } catch (error) {
          result = { isError: true, content: [{ type: "text", text: /^CODE_READ_[A-Z_]+$/.test(error.code || "") ? error.code : "CODE_READ_FAILED" }] };
        }
      } else throw failure("CODE_READ_METHOD_NOT_ALLOWED");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    } catch {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid request" } }));
    }
  });
  server.requestTimeout = 60_000;
  const close = () => closing ??= (async () => {
    closed = true;
    signal?.removeEventListener("abort", onAbort);
    try {
      session.close();
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } catch (error) {
      session.revoke();
      throw error;
    }
  })();
  const onAbort = () => { session.revoke(); void close().catch(() => {}); };
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    server.on("error", () => { session.revoke(); void close().catch(() => {}); });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { await close(); signal.throwIfAborted(); }
    return {
      url: `http://127.0.0.1:${server.address().port}${endpointPath}`,
      manifestText,
      assertComplete: (paths) => session.assertComplete(paths),
      commit: () => session.commit(),
      revoke: () => session.revoke(),
      close,
    };
  } catch (error) {
    session.revoke();
    await close();
    throw error;
  }
}
