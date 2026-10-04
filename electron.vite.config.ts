import { defineConfig } from "electron-vite";
// TypeScript's react-jsx transform is sufficient; full reloads keep the dev setup simple.
export default defineConfig({ main: {}, preload: {}, renderer: {} });
