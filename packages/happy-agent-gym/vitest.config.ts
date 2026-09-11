import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: ["../../scripts/windowsSandboxTestSetup.ts"],
        include: ["tests/**/*.test.ts"],
        // A gym starts a daemon, two databases and a socket. Files run one at a time so a slow
        // machine does not turn resource contention into a timeout.
        fileParallelism: false,
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
