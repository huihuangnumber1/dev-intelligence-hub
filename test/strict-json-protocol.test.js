import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonWithUniqueKeys, parseProtocolJsonWithUniqueKeys } from "../src/lib/strict-json.js";

test("protocol metadata budget is separate from model result validation", () => {
  const text = JSON.stringify(Array.from({ length: 25_000 }, (_, i) => ({ name: `tool_${i}` })));
  assert.throws(() => parseJsonWithUniqueKeys(text), SyntaxError);
  assert.equal(parseProtocolJsonWithUniqueKeys(text).length, 25_000);
});

test("protocol parsing still bounds bytes, nodes, depth and duplicate keys", () => {
  for (const text of [
    '"' + "x".repeat(8 * 1024 * 1024) + '"',
    JSON.stringify(Array(200_001).fill(0)),
    "[".repeat(66) + "0" + "]".repeat(66),
    '{"result":{"same":1,"same":2}}',
    '{"result":{"same":1,"s\\u0061me":2}}',
  ]) assert.throws(() => parseProtocolJsonWithUniqueKeys(text), SyntaxError);
});
