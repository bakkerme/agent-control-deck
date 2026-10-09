import { chmodSync, lstatSync, readdirSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Git objects are read-only on Windows. Clear that attribute before native rm,
// and unlink junctions without walking into their targets (or an ancestor).
export function removeFixture(directory: string): void {
  const root = realpathSync.native(directory);
  function prepare(path: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      unlinkSync(path);
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(path)) prepare(join(path, name));
    } else if (process.platform === "win32" && !(stat.mode & 0o200)) {
      chmodSync(path, stat.mode | 0o200);
    }
  }
  prepare(root);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
