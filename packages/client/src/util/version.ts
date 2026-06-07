// Tiny SemVer helpers for comparing the running game's build-time package
// versions (__PKG_VERSIONS__) against a release's per-package versions.

/** Compare two MAJOR.MINOR.PATCH strings: 1 if a > b, -1 if a < b, else 0. */
export function compareVer(a: string, b: string): number {
  const pa = (a.match(/\d+/g) ?? []).map(Number);
  const pb = (b.match(/\d+/g) ?? []).map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** True when any package's remote version is greater than the local one. */
export function anyPackageBehind(
  local: Record<string, string>,
  remote: Record<string, string>,
): boolean {
  return Object.entries(remote).some(([label, r]) => {
    const l = local[label];
    return Boolean(l) && compareVer(r, l) > 0;
  });
}

/** The local (build-time) workspace package versions injected by Vite. */
export function localPackageVersions(): Record<string, string> {
  return (typeof __PKG_VERSIONS__ !== "undefined" ? __PKG_VERSIONS__ : {}) ?? {};
}
