import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["sources/**/*.test.ts"],
        exclude: ["sources/**/*.live.test.ts"],
        setupFiles: ["./vitest.setup.ts"],
    },
});
