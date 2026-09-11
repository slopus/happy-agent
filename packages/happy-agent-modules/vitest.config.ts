import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: ["../../scripts/windowsSandboxTestSetup.ts"],
        exclude: ["tests/**/*.live.test.ts"],
        include: ["tests/**/*.test.ts"],
    },
});
