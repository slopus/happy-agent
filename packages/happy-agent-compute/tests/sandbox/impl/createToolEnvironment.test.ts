import { describe, expect, it } from "vitest";

import { createToolEnvironment } from "../../../sources/sandbox/impl/createToolEnvironment.js";

describe("createToolEnvironment", () => {
    it("keeps developer toolchains while removing model-writable search paths", async () => {
        const environment = {
            HOME: "/home/user",
            PATH: "/workspace/node_modules/.bin:/home/user/.cargo/bin:/tmp/attacker:/nix/store/tool/bin:/home/user/.ssh/bin:relative/bin:/usr/bin",
            TMPDIR: "/tmp",
        };

        const restricted = await createToolEnvironment("workspace_write", environment, {
            cwd: "/workspace",
            homeDirectory: "/home/user",
            temporaryDirectory: "/tmp",
        });

        if (process.platform === "win32") {
            expect(restricted.PATH).toBe(environment.PATH);
        } else {
            const paths = restricted.PATH?.split(":") ?? [];
            expect(paths.some((path) => path.endsWith("/home/user/.cargo/bin"))).toBe(true);
            expect(paths).toContain("/nix/store/tool/bin");
            expect(paths).toContain("/usr/bin");
            expect(paths).not.toContain("/workspace/node_modules/.bin");
            expect(paths).not.toContain("/tmp/attacker");
            expect(paths).not.toContain("/home/user/.ssh/bin");
            expect(paths).not.toContain("relative/bin");
        }
        expect((await createToolEnvironment("full_access", environment)).PATH).toBe(
            environment.PATH,
        );
    });
});

it.runIf(process.platform === "win32")(
    "scopes Git ownership trust to the selected workspace without changing full access",
    async () => {
        const environment = {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "core.autocrlf",
            GIT_CONFIG_VALUE_0: "false",
        };
        const restricted = await createToolEnvironment("read_only", environment, {
            cwd: "C:\\projects\\selected",
        });
        expect(restricted.GIT_CONFIG_COUNT).toBe("2");
        expect(restricted.GIT_CONFIG_KEY_0).toBe("core.autocrlf");
        expect(restricted.GIT_CONFIG_KEY_1).toBe("safe.directory");
        expect(restricted.GIT_CONFIG_VALUE_1).toBe("C:/projects/selected");
        const full = await createToolEnvironment("full_access", environment, {
            cwd: "C:\\projects\\selected",
        });
        expect(full.GIT_CONFIG_COUNT).toBe("1");
        expect(full.GIT_CONFIG_KEY_1).toBeUndefined();
    },
);
