import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeFixture } from "./fixture-cleanup";

test("fixture cleanup removes read-only Git objects without following junction targets", () => {
  const outside = mkdtempSync(join(tmpdir(), "acd-cleanup-target-"));
  const root = mkdtempSync(join(tmpdir(), "acd-cleanup-"));
  try {
    writeFileSync(join(outside, "keep.txt"), "Keep target contents");
    mkdirSync(join(root, ".git", "objects"), { recursive: true });
    const object = join(root, ".git", "objects", "readonly");
    writeFileSync(object, "Git object");
    chmodSync(object, 0o444);
    symlinkSync(outside, join(root, "external"), process.platform === "win32" ? "junction" : "dir");
    symlinkSync(root, join(root, "ancestor"), process.platform === "win32" ? "junction" : "dir");
    removeFixture(root);
    assert.equal(existsSync(root), false);
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "Keep target contents");
  } finally {
    if (existsSync(root)) removeFixture(root);
    removeFixture(outside);
  }
});
