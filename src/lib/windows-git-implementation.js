import path from "node:path";

// Pin the native implementation rather than the cmd/bin forwarding executable.
// Git for Windows 2.56 moved its x64 implementation from MINGW64 to UCRT64.
const IMPLEMENTATION_DIRECTORIES = Object.freeze(["ucrt64", "mingw64", "mingw32"]);

export function isWindowsGitImplementationPath(value) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  const normalized = path.win32.normalize(value).replaceAll("\\", "/").toLowerCase();
  return /^[a-z]:\//u.test(normalized) &&
    /\/(?:mingw(?:32|64)|ucrt64)\/bin\/git\.exe$/u.test(normalized);
}

export function windowsGitImplementationCandidates(command) {
  if (typeof command !== "string" || !path.win32.isAbsolute(command)) return [];
  const normalized = path.win32.normalize(command);
  const parent = path.win32.dirname(path.win32.dirname(normalized));
  const installationRoot = isWindowsGitImplementationPath(normalized)
    ? path.win32.dirname(parent) : parent;
  const candidates = [normalized, ...IMPLEMENTATION_DIRECTORIES.map(directory =>
    path.win32.join(installationRoot, directory, "bin", "git.exe"))];
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = candidate.toLowerCase();
    if (!isWindowsGitImplementationPath(candidate) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
