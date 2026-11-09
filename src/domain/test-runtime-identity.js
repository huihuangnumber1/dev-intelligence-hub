const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const WINDOWS_KEYS = ["schemaVersion", "kind", "executionId", "actionId", "pid", "processStartTimeUtcTicks", "executableSha256"];
// DeriveCapabilitySidsFromName("registryRead"). No network capability is valid
// for this fixed offline runtime.
export const WINDOWS_REGISTRY_READ_CAPABILITY_SID = "S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681";

export function isWindowsIsolationProof(value) {
  const keys = ["kind", "appContainerSid", "integritySid", "noAllApplicationPackages", "capabilitySids", "allApplicationPackagesAccessGranted"];
  return value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length &&
    Reflect.ownKeys(value).every(key => keys.includes(key) && Object.getOwnPropertyDescriptor(value, key).enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value")) &&
    value.kind === "windows-lpac" && typeof value.appContainerSid === "string" && /^S-1-15-2(?:-\d+){7}$/u.test(value.appContainerSid) &&
    value.integritySid === "S-1-16-4096" && value.noAllApplicationPackages === 1 && value.allApplicationPackagesAccessGranted === false &&
    Array.isArray(value.capabilitySids) && Object.getPrototypeOf(value.capabilitySids) === Array.prototype &&
    Reflect.ownKeys(value.capabilitySids).length === 2 && Reflect.ownKeys(value.capabilitySids).every(key => ["0", "length"].includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value.capabilitySids, key), "value")) &&
    value.capabilitySids.length === 1 && value.capabilitySids[0] === WINDOWS_REGISTRY_READ_CAPABILITY_SID;
}

export function isWindowsRuntimeIdentity(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  const expected = [...WINDOWS_KEYS, ...(Object.getOwnPropertyDescriptor(value, "schemaVersion")?.value === 2 ? ["isolation"] : [])];
  if (keys.length !== expected.length || keys.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !expected.includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value");
  })) return false;
  return [1, 2].includes(value.schemaVersion) && (value.schemaVersion === 1 || isWindowsIsolationProof(value.isolation)) && value.kind === "windows-process" &&
    typeof value.executionId === "string" && SAFE_ID.test(value.executionId) &&
    typeof value.actionId === "string" && SAFE_ID.test(value.actionId) &&
    Number.isSafeInteger(value.pid) && value.pid > 0 &&
    typeof value.processStartTimeUtcTicks === "string" && /^\d{18,19}$/u.test(value.processStartTimeUtcTicks) &&
    typeof value.executableSha256 === "string" && SHA256.test(value.executableSha256);
}

export function executionIdentityKeys(value) {
  return Object.hasOwn(value ?? {}, "runtimeIdentity")
    ? ["runtimeIdentity", "assetVersion", "verificationKind"] : ["imageId"];
}

export function executionIdentityFields(value) {
  return Object.fromEntries(executionIdentityKeys(value).map((key) => [key, key === "runtimeIdentity" ? { ...value[key], ...(value[key]?.isolation ? {
    isolation: { ...value[key].isolation, capabilitySids: [...value[key].isolation.capabilitySids] },
  } : {}) } : value[key]]));
}

export function isExecutionIdentityProof(value, imagePattern = /^sha256:[a-f0-9]{64}$/u) {
  if (Object.hasOwn(value ?? {}, "runtimeIdentity")) {
    return !Object.hasOwn(value, "imageId") && isWindowsRuntimeIdentity(value.runtimeIdentity) &&
      Number.isSafeInteger(value.assetVersion) && value.assetVersion > 0 && value.assetVersion <= 1_000_000 &&
      ["test", "build"].includes(value.verificationKind);
  }
  return !Object.hasOwn(value ?? {}, "assetVersion") && !Object.hasOwn(value ?? {}, "verificationKind") &&
    typeof value?.imageId === "string" && imagePattern.test(value.imageId);
}
