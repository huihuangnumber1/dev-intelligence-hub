import assert from "node:assert/strict";
import test from "node:test";
import { parseNativeResultJson } from "../src/lib/native-result-json.js";
import { parseJsonWithUniqueKeys } from "../src/lib/strict-json.js";

test("native result decoding preserves raw string line breaks without changing valid JSON", () => {
  const expected = { summary: 'line one\nline two\r\n\t"quoted" and \\ path', intent: { type: "submit_delivery" } };
  const valid = JSON.stringify(expected);
  const malformed = valid.replaceAll("\\n", "\n").replaceAll("\\r", "\r").replaceAll("\\t", "\t");
  assert.throws(() => parseJsonWithUniqueKeys(malformed));
  assert.deepEqual(parseNativeResultJson(malformed), expected);
  assert.deepEqual(parseNativeResultJson(valid), expected);
  assert.deepEqual(parseNativeResultJson('{\n"ok": true\n}'), { ok: true });
});

test("native normalization retains duplicate-key, syntax, control-character and depth rejection", () => {
  for (const value of [
    '{"value":"line\nbreak", "value":"duplicate"}',
    '{"a\nb":1,"a\\nb":2}',
    '{"value":"line\nbreak",}',
    '{"value":"line\nbreak}',
    '{"value":"line\nbreak", "other":"bad\\q"}',
    '{"value":"line\u0000break"}',
    '{"value":"line\\\nbreak"}',
    '{"value":"line\nbreak"}\u0000',
    '['.repeat(70) + '"line\nbreak"' + ']'.repeat(70),
  ]) assert.throws(() => parseNativeResultJson(value), SyntaxError);
});
