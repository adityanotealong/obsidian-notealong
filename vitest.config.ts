import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Unit tests never load the real "obsidian" package (it has no runtime
    // code); the few imports the sync core needs are shimmed.
    alias: { obsidian: new URL("./test/obsidian-shim.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
