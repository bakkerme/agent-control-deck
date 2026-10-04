import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { codexPrompt, promptTitle } from "../src/shared/presentation";
import MarkdownPreview from "../src/renderer/MarkdownPreview";
import { displayName, displayPreview } from "../src/renderer/components";
import type { Chat } from "../src/shared/types";

const fileContext = "# Files mentioned by the user:\n\n## memcard-viewer: /Users/brandon/Library/Mobile Documents/com~apple~CloudDocs/memcard-viewer\n";

test("Codex titles distinguish attachment context from the user's request", () => {
  assert.equal(promptTitle(`${fileContext}\nFix the card viewer`, true), "Fix the card viewer");
  assert.equal(promptTitle(`${fileContext}\n<user_query>\n# Fix the viewer\n</user_query>`, true), "Fix the viewer");
  assert.equal(promptTitle(fileContext, true), "memcard-viewer");
  assert.equal(promptTitle(fileContext.replace(/\s+/g, " ").slice(0, 100), true), "memcard-viewer");
  assert.equal(promptTitle("# Files mentioned by the user:\n## deck: C:\\Work Files\\deck\n\nFix this", true), "Fix this");
  assert.equal(promptTitle(`${fileContext}\n## other: /work/other\n\nImprove both`, true), "Improve both");
  assert.equal(promptTitle("Normal prompt\nwith more text", true), "Normal prompt with more text");
  assert.equal(promptTitle("x".repeat(200), true).length, 100);
  assert.equal(codexPrompt("# Files mentioned by the user: explain this phrase").content, "# Files mentioned by the user: explain this phrase");
});

test("legacy generated titles and previews improve without changing user names", () => {
  const chat = { provider: "codex", name: "", providerTitle: fileContext.replace(/\s+/g, " ").slice(0, 100), preview: fileContext.replace(/\s+/g, " ") } as Chat;
  assert.equal(displayName(chat), "memcard-viewer");
  assert.equal(displayPreview(chat), "memcard-viewer");
  assert.equal(displayName({ ...chat, name: "My chosen name" }), "My chosen name");
  assert.equal(displayName({ ...chat, provider: "manual", providerTitle: "# Keep this literal title" }), "# Keep this literal title");
});

test("Markdown previews render structure while keeping HTML, images and links inert", () => {
  const html = renderToStaticMarkup(createElement(MarkdownPreview, { text: "## Ready\n\n**Fixed** and `code`\n\n- First\n- Second\n\n```ts\nconst x = 1;\n```\n\n| Field | Value |\n| --- | --- |\n| State | Idle |\n\n<script>alert(1)</script>\n\n[Open](javascript:alert%281%29) ![Remote](https://example.com/image.png)" }));
  assert.ok(html.includes("<h2>Ready</h2>"));
  assert.ok(html.includes("<strong>Fixed</strong>"));
  assert.ok(html.includes("<li>First</li>"));
  assert.ok(html.includes("<pre><code"));
  assert.ok(html.includes("<table>"));
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<a "));
  assert.ok(!html.includes("javascript:"));
  assert.ok(html.includes("[Image: Remote]"));
});
