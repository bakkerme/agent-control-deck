import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import type { PlanningSnapshot } from "../shared/planning";
import { PlanningStore, planDigest } from "./planning-store";
// User-authored cards have a separate, review-only inbox. Never consume agent events here.
export function readPlanInbox(
  root: string,
  planning: PlanningStore,
): PlanningSnapshot["inbox"] {
  const path = join(root, "plan-inbox"),
    files: PlanningSnapshot["inbox"]["files"] = [];
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const imported = new Set(planning.imports().map((i) => i.id));
    const names = readdirSync(path)
      .filter((name) => /\.(md|markdown)$/i.test(name))
      .sort();
    for (const name of names.slice(0, 50)) {
      let file: number | undefined;
      try {
        const filename = join(path, name),
          before = lstatSync(filename);
        if (!before.isFile() || before.isSymbolicLink())
          throw new Error("Only regular Markdown files are accepted");
        file = openSync(
          filename,
          constants.O_RDONLY |
            (constants.O_NOFOLLOW ?? 0) |
            (constants.O_NONBLOCK ?? 0),
        );
        const stat = fstatSync(file);
        if (!stat.isFile())
          throw new Error("Only regular Markdown files are accepted");
        if (stat.size > 100000) throw new Error("Card exceeds 100,000 bytes");
        const markdown = readFileSync(file, "utf8");
        if (imported.has(planDigest(markdown))) continue;
        files.push({ name, markdown, error: null });
      } catch (error) {
        files.push({
          name,
          markdown: "",
          error:
            error instanceof Error ? error.message : "Cannot read this card",
        });
      } finally {
        if (file !== undefined) closeSync(file);
      }
      if (files.length >= 20) break;
    }
    return {
      path,
      files,
      error:
        names.length > 50
          ? "Showing the first 50 card files. Move reviewed files out of the inbox to see more."
          : null,
    };
  } catch {
    return {
      path,
      files,
      error:
        "Cannot read the plan inbox. Files remain on disk; check permissions and retry.",
    };
  }
}
