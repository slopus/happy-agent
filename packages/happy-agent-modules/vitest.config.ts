import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Tests delete database folders; the unpatched libSQL binding frees its files only on GC.
        poolOptions: { forks: { execArgv: ["--expose-gc"] } },
        setupFiles: [
            "../../scripts/windowsSandboxTestSetup.ts",
            "../../scripts/isolateHappyTestEnvironment.ts",
        ],
        exclude: ["tests/**/*.live.test.ts"],
        include: ["tests/**/*.test.ts"],
    },
});
