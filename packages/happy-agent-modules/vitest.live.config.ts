import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: ["../../scripts/windowsSandboxTestSetup.ts"],
        include: ["tests/**/*.live.test.ts"],
    },
});
