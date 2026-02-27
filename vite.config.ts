import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "./",
  root: path.resolve(__dirname, "src/renderer"),
  publicDir: path.resolve(__dirname, "assets"),
  build: {
    outDir: path.resolve(__dirname, "build/renderer"),
    emptyOutDir: true
  }
});
