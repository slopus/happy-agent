import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: ["../../scripts/windowsSandboxTestSetup.ts"],
        include: ["tests/**/*.test.ts"],
        // Windows PowerShell process startup and process-tree shutdown can exceed five seconds.
        maxWorkers: process.platform === "win32" ? 2 : undefined,
        testTimeout: process.platform === "win32" ? 20_000 : 5_000,
    },
});
