import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        setupFiles: [
            "../../scripts/windowsSandboxTestSetup.ts",
            "../../scripts/isolateHappyTestEnvironment.ts",
        ],
        exclude: ["tests/**/*.live.test.ts"],
        include: ["tests/**/*.test.ts"],
    },
});
