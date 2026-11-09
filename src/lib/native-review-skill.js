import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NATIVE_REVIEW_SKILL_NAME = "dih-pr-review";
export const NATIVE_REVIEW_SKILL_DOCUMENT = "review-skill/SKILL.md";
export const NATIVE_REVIEW_SKILL_FILE = `.agents/skills/${NATIVE_REVIEW_SKILL_NAME}/SKILL.md`;
const sourceRoot = fileURLToPath(new URL("../skills/", import.meta.url));
const personas = ["correctness", "testing", "reliability", "security", "performance", "adversarial"];
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

async function resource(file, root) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 128 * 1024) {
    throw new Error("REVIEW_SKILL_SOURCE_UNSAFE");
  }
  const [actualFile, actualRoot] = await Promise.all([realpath(file), realpath(root)]);
  const relative = path.relative(actualRoot, actualFile);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("REVIEW_SKILL_SOURCE_UNSAFE");
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size || opened.nlink !== 1 || !opened.isFile()) {
      throw new Error("REVIEW_SKILL_SOURCE_UNSAFE");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length > 128 * 1024 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error("REVIEW_SKILL_SOURCE_UNSAFE");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally { await handle.close(); }
}

export async function loadNativeReviewSkill({ home = homedir() } = {}) {
  const documents = {
    [NATIVE_REVIEW_SKILL_DOCUMENT]: await resource(path.join(sourceRoot, `${NATIVE_REVIEW_SKILL_NAME}/SKILL.md`), sourceRoot),
    "review-skill/references/quick-review.md": await resource(path.join(sourceRoot, "quick-pr-review/SKILL.md"), sourceRoot),
  };
  const sources = ["bundled-background-adapter", "bundled-quick-review"];
  const unavailable = [];
  for (const location of [".codex/skills", ".agents/skills"]) {
    const root = path.join(home, location);
    try {
      documents["review-skill/references/tiering.md"] = await resource(path.join(root, "pr-review-tiering/SKILL.md"), root);
      sources.push("installed-pr-review-tiering");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") unavailable.push("installed-tiering-source-unavailable");
    }
  }
  if (!documents["review-skill/references/tiering.md"]) unavailable.push("installed-tiering-not-found");
  const pluginRoot = path.join(home, ".codex/plugins/cache/compound-engineering-plugin/compound-engineering");
  let versions = [];
  try { versions = (await readdir(pluginRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => entry.name).sort((a, b) => b.localeCompare(a, "en", { numeric: true })); }
  catch (error) { if (error.code !== "ENOENT") unavailable.push("installed-ce-source-unavailable"); }
  if (versions.length) {
    const root = path.join(pluginRoot, versions[0]);
    for (const persona of personas) {
      try {
        documents[`review-skill/references/${persona}.md`] = await resource(
          path.join(root, `skills/ce-code-review/references/personas/${persona}-reviewer.md`), root,
        );
      } catch { unavailable.push(`ce-${persona}-not-loaded`); }
    }
    if (personas.some((persona) => documents[`review-skill/references/${persona}.md`])) sources.push("installed-ce-personas");
  } else unavailable.push("installed-ce-personas-not-found");
  const files = Object.entries(documents).map(([document, text]) => ({ document, sha256: sha256(text) }));
  const digest = sha256(JSON.stringify(files));
  documents["review-skill/manifest.json"] = JSON.stringify({
    name: NATIVE_REVIEW_SKILL_NAME, digest, sources, unavailable: [...new Set(unavailable)], files,
    fullCeWorkflow: false, crossModelReview: false,
  }, null, 2);
  return Object.freeze({ name: NATIVE_REVIEW_SKILL_NAME, digest, documents: Object.freeze(documents) });
}
