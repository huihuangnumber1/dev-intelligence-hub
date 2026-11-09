const MAXIMUM_DEPTH = 64;
const MAXIMUM_NODES = 20_000;
const MAXIMUM_KEYS = 20_000;
const NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const STRING_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

function invalidJson() {
  return new SyntaxError("JSON is invalid");
}

function skipWhitespace(state) {
  while (state.index < state.text.length) {
    const code = state.text.charCodeAt(state.index);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return;
    }
    state.index += 1;
  }
}

function parseStringToken(state, decode) {
  const start = state.index;
  if (state.text[state.index] !== '"') throw invalidJson();
  state.index += 1;
  while (state.index < state.text.length) {
    const code = state.text.charCodeAt(state.index);
    if (code === 0x22) {
      state.index += 1;
      if (!decode) return null;
      try {
        return JSON.parse(state.text.slice(start, state.index));
      } catch {
        throw invalidJson();
      }
    }
    if (code < 0x20) throw invalidJson();
    if (code !== 0x5c) {
      state.index += 1;
      continue;
    }
    state.index += 1;
    const escape = state.text[state.index];
    if (escape === undefined) throw invalidJson();
    if (escape === "u") {
      const digits = state.text.slice(state.index + 1, state.index + 5);
      if (!/^[a-f0-9]{4}$/iu.test(digits)) throw invalidJson();
      state.index += 5;
      continue;
    }
    if (!STRING_ESCAPES.has(escape)) {
      throw invalidJson();
    }
    state.index += 1;
  }
  throw invalidJson();
}

function consumeValueBudget(state, depth) {
  state.nodes += 1;
  if (depth > MAXIMUM_DEPTH || state.nodes > state.maximumNodes) {
    throw invalidJson();
  }
}

function parseObject(state, depth) {
  state.index += 1;
  skipWhitespace(state);
  if (state.text[state.index] === "}") {
    state.index += 1;
    return;
  }
  const keys = new Set();
  while (state.index < state.text.length) {
    const key = parseStringToken(state, true);
    state.keys += 1;
    if (state.keys > state.maximumKeys || keys.has(key)) throw invalidJson();
    keys.add(key);
    skipWhitespace(state);
    if (state.text[state.index] !== ":") throw invalidJson();
    state.index += 1;
    skipWhitespace(state);
    parseValue(state, depth + 1);
    skipWhitespace(state);
    if (state.text[state.index] === "}") {
      state.index += 1;
      return;
    }
    if (state.text[state.index] !== ",") throw invalidJson();
    state.index += 1;
    skipWhitespace(state);
  }
  throw invalidJson();
}

function parseArray(state, depth) {
  state.index += 1;
  skipWhitespace(state);
  if (state.text[state.index] === "]") {
    state.index += 1;
    return;
  }
  while (state.index < state.text.length) {
    parseValue(state, depth + 1);
    skipWhitespace(state);
    if (state.text[state.index] === "]") {
      state.index += 1;
      return;
    }
    if (state.text[state.index] !== ",") throw invalidJson();
    state.index += 1;
    skipWhitespace(state);
  }
  throw invalidJson();
}

function consumeLiteral(state, literal) {
  if (!state.text.startsWith(literal, state.index)) throw invalidJson();
  state.index += literal.length;
}

function parseValue(state, depth) {
  consumeValueBudget(state, depth);
  const token = state.text[state.index];
  if (token === "{") return parseObject(state, depth);
  if (token === "[") return parseArray(state, depth);
  if (token === '"') return parseStringToken(state, false);
  if (token === "t") return consumeLiteral(state, "true");
  if (token === "f") return consumeLiteral(state, "false");
  if (token === "n") return consumeLiteral(state, "null");
  NUMBER_PATTERN.lastIndex = state.index;
  const number = NUMBER_PATTERN.exec(state.text);
  if (!number) throw invalidJson();
  state.index = NUMBER_PATTERN.lastIndex;
}

function parseJson(text, maximumNodes, maximumKeys) {
  if (typeof text !== "string") throw invalidJson();
  const state = { text, index: 0, nodes: 0, keys: 0, maximumNodes, maximumKeys };
  skipWhitespace(state);
  parseValue(state, 0);
  skipWhitespace(state);
  if (state.index !== text.length) throw invalidJson();
  try {
    return JSON.parse(text);
  } catch {
    throw invalidJson();
  }
}

export function parseJsonWithUniqueKeys(text) {
  return parseJson(text, MAXIMUM_NODES, MAXIMUM_KEYS);
}

// App-server metadata includes inherited tool schemas, unlike a model result.
// Keep its frame budget separate so result validation remains equally strict.
export function parseProtocolJsonWithUniqueKeys(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 8 * 1024 * 1024) throw invalidJson();
  return parseJson(text, 200_000, 200_000);
}
