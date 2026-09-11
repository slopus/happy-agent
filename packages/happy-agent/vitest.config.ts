import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: ["../../scripts/windowsSandboxTestSetup.ts"],
        // Windows startup provisions private ACLs through PowerShell; bound concurrency
        // keeps these integration fixtures from competing with every other worker.
        ...(process.platform === "win32"
            ? { testTimeout: 30_000, hookTimeout: 30_000, maxWorkers: 2 }
            : {}),
        include: ["tests/**/*.test.ts"],
    },
});
