import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    outDir: "build",
    sourcemap: true,
  },
  server: {
    proxy: {
      "^/api.*": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
  plugins: [react()],
  legacy: {
    // Fix AceEditor rendering. See:
    // https://github.com/securingsincity/react-ace/issues/1540#issuecomment-3685386545
    inconsistentCjsInterop: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    testTimeout: 20000,
  },
});
