import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The other tests/*.test.ts files are node:test suites run by `npm test`
    // through jiti; vitest owns only the quiet startup sync suites.
    include: ["tests/sync-policy.test.ts", "tests/quiet-startup-sync.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
