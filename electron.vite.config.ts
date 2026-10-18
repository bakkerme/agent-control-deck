import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { defineConfig } from "electron-vite";
// TypeScript's react-jsx transform is sufficient; full reloads keep the dev setup simple.
export default defineConfig({ main: { define: { __SDK_SUPERVISOR_SOURCE_HASH__: JSON.stringify(createHash("sha256").update(readFileSync("src/main/sdk-supervisor.c")).digest("hex")) } }, preload: {}, renderer: {} });
