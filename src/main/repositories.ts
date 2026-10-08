import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import type { Source } from "../shared/types";

export function canonicalPath(value: string): string {
  if (/^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\") || value.startsWith("//")) {
    const path = win32.normalize(value).replace(/\\/g, "/").toLowerCase();
    return /^[a-z]:\/$/.test(path) ? path : path.replace(/\/$/, "");
  }
  if (!value.startsWith("/")) throw new Error("Workspace paths must be absolute");
  return posix.normalize(value).replace(/\/$/, "") || "/";
}

export interface RepositoryLocation {
  root: string;
  identity: string | null;
  name: string;
}
function markerText(path: string): string | null {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192) return null;
    const buffer = Buffer.alloc(8193);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length > 8192) return null;
    const value = buffer.toString("utf8", 0, length).trim();
    return value && !value.includes("\0") ? value : null;
  } finally { closeSync(fd); }
}

// Read only Git's location markers, never provider storage, Git config, or objects.
// An inaccessible/broken pointer still establishes a separate checkout boundary.
export function repositoryLocation(path: string, source: Source): RepositoryLocation | null {
  path = canonicalPath(path);
  if (source.environment !== "native" || (process.platform !== "win32" && !path.startsWith("/"))) return null;
  if (process.platform === "win32" && !/^(?:[a-z]:\/|\/\/)/i.test(path)) return null;
  let current = path;
  while (true) {
    const marker = join(current, ".git");
    let hasMarker = false;
    try { lstatSync(marker); hasMarker = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") return null; }
    if (hasMarker) {
      const fallback = { root: canonicalPath(current), identity: null, name: basename(current) || current };
      try {
        // Native realpath expands Windows 8.3 aliases such as RUNNER~1.
        // Git's worktree pointers may use the long spelling of the same path.
        const root = canonicalPath(realpathSync.native(current));
        const directory = statSync(marker).isDirectory()
          ? realpathSync.native(marker)
          : resolve(current, /^gitdir: (.+)$/i.exec(markerText(marker) ?? "")?.[1] ?? "");
        if (directory === resolve(current) || !statSync(directory).isDirectory()) return fallback;
        const commonMarker = join(directory, "commondir");
        const common = existsSync(commonMarker) ? markerText(commonMarker) : null;
        if (existsSync(commonMarker) && !common) return fallback;
        const identity = canonicalPath(realpathSync.native(common ? resolve(directory, common) : directory));
        if (!statSync(identity).isDirectory()) return fallback;
        const name = basename(identity) === ".git" ? basename(dirname(identity))
          : common ? basename(identity).replace(/\.git$/i, "") : basename(root);
        return { root, identity, name: name || root };
      } catch { return fallback; }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export const repositoryRoot = (path: string, source: Source): string | null => repositoryLocation(path, source)?.root ?? null;
