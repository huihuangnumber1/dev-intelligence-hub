import { parseJsonWithUniqueKeys } from "./strict-json.js";

const STRING_WHITESPACE_ESCAPES = new Map([["\n", "\\n"], ["\r", "\\r"], ["\t", "\\t"]]);

// Native structured output wraps JSON in a string. Some responses leave literal
// line breaks in that inner JSON's string values. Preserve those characters;
// do not infer missing quotes, keys, delimiters or other malformed syntax.
export function parseNativeResultJson(text) {
  try {
    return parseJsonWithUniqueKeys(text);
  } catch (original) {
    if (typeof text !== "string") throw original;
    let quoted = false;
    let escaped = false;
    let start = 0;
    const parts = [];
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (quoted && !escaped && STRING_WHITESPACE_ESCAPES.has(character)) {
        parts.push(text.slice(start, index), STRING_WHITESPACE_ESCAPES.get(character));
        start = index + 1;
        continue;
      }
      if (escaped) escaped = false;
      else if (quoted && character === "\\") escaped = true;
      else if (character === '"') quoted = !quoted;
    }
    if (parts.length === 0) throw original;
    parts.push(text.slice(start));
    // Duplicate decoded keys, syntax and resource limits remain authoritative.
    return parseJsonWithUniqueKeys(parts.join(""));
  }
}
