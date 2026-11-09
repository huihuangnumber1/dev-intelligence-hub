import path from "node:path";

export function isWindowsTestProfile(profile) {
  return ["windows-test", "windows-build"].includes(profile?.kind);
}

function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("Invalid Windows test profile");
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) throw new TypeError("Invalid Windows test profile");
}

export function normalizeWindowsTestProfile(profile) {
  exact(profile, ["kind", "nodeExecutable", "nodeSha256", "timeoutMs", "asset", ...(Object.hasOwn(profile, "resources") ? ["resources"] : [])]);
  const { kind, nodeExecutable, nodeSha256, timeoutMs, asset } = profile;
  if (!isWindowsTestProfile(profile) || typeof nodeExecutable !== "string" || !/^[a-z]:[\\/]/iu.test(nodeExecutable) || !path.win32.isAbsolute(nodeExecutable) ||
    /[\p{Cc}]/u.test(nodeExecutable) || path.win32.basename(nodeExecutable).toLowerCase() !== "node.exe" ||
    typeof nodeSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(nodeSha256) ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) throw new TypeError("Invalid Windows test profile");
  exact(asset, ["schemaVersion", "title", "description", "version", "source"]);
  if (asset.schemaVersion !== 1 || !Number.isSafeInteger(asset.version) || asset.version < 1 || asset.version > 1_000_000 ||
    [["title", 256], ["description", 2048], ["source", 64 * 1024]].some(([key, max]) => typeof asset[key] !== "string" || !asset[key].length || asset[key].length > max)) throw new TypeError("Invalid Windows test asset");
  let resources;
  if (Object.hasOwn(profile, "resources")) {
    if (!Array.isArray(profile.resources) || profile.resources.length > 16) throw new TypeError("Invalid Windows test resources");
    const names = new Set();
    resources = profile.resources.map(resource => {
      exact(resource, ["name", "sourcePath", "sha256", "kind"]);
      if (typeof resource.name !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(resource.name) || names.has(resource.name) ||
        typeof resource.sourcePath !== "string" || !/^[a-z]:[\\/]/iu.test(resource.sourcePath) || !path.win32.isAbsolute(resource.sourcePath) || /["\p{Cc}]/u.test(resource.sourcePath) || resource.sourcePath.slice(2).includes(":") ||
        !["file", "directory"].includes(resource.kind) || typeof resource.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(resource.sha256)) throw new TypeError("Invalid Windows test resource");
      names.add(resource.name);
      return { ...resource };
    });
  }
  return { kind, nodeExecutable, nodeSha256, timeoutMs, asset: { ...asset }, ...(resources === undefined ? {} : { resources }) };
}
