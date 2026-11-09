import { normalizeWorkspacePath } from "../domain/code-execution-policy.js";

function failure(code) { return Object.assign(new Error(code), { code }); }
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw failure("CODE_EDIT_ARGUMENT_INVALID");
  }
}

export function normalizeCodeSourceEdits(value) {
  exact(value, ["path", "sourceVersion", "edits"]);
  let path;
  try { path = normalizeWorkspacePath(value.path); } catch { throw failure("CODE_EDIT_ARGUMENT_INVALID"); }
  if (typeof value.sourceVersion !== "string" || !value.sourceVersion || value.sourceVersion.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(value.sourceVersion) || !Array.isArray(value.edits) ||
      value.edits.length < 1 || value.edits.length > 32) throw failure("CODE_EDIT_ARGUMENT_INVALID");
  let total = 0;
  const edits = value.edits.map(edit => {
    exact(edit, ["oldText", "newText"]);
    for (const text of [edit.oldText, edit.newText]) {
      if (typeof text !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ||
          Buffer.byteLength(text) > 48 * 1024 || Buffer.from(text).toString("utf8") !== text) {
        throw failure("CODE_EDIT_ARGUMENT_INVALID");
      }
      total += Buffer.byteLength(text);
    }
    if (!edit.oldText || edit.oldText === edit.newText) throw failure("CODE_EDIT_ARGUMENT_INVALID");
    return { oldText: edit.oldText, newText: edit.newText };
  });
  if (total > 128 * 1024) throw failure("CODE_EDIT_ARGUMENT_INVALID");
  return { path, sourceVersion: value.sourceVersion, edits };
}

// Resolve every replacement before admission; preserve all unmentioned bytes.
export function applyCodeSourceEdits(content, edits) {
  for (const { oldText, newText } of edits) {
    const index = content.indexOf(oldText);
    if (index < 0 || content.indexOf(oldText, index + 1) !== -1) throw failure("CODE_EDIT_MATCH_NOT_UNIQUE");
    content = content.slice(0, index) + newText + content.slice(index + oldText.length);
  }
  return content;
}
