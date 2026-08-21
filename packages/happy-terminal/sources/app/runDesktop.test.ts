import { describe, expect, it } from "vitest";

import {
    desktopApplicationEntrypoint,
    desktopBuilderConfiguration,
    desktopLoginShell,
    desktopHappyTerminalLauncher,
} from "./desktopApplicationRuntime.js";

describe("Happy desktop packaging", () => {
    it("boots Happy with the bundled Happy Terminal command ahead of the login-shell environment", () => {
        expect(desktopApplicationEntrypoint()).toContain(
            'join(process.resourcesPath, "happy-terminal-runtime", "bin")',
        );
        expect(desktopApplicationEntrypoint()).toContain(
            'process.env.SHELL = join(runtimeBin, "happy2-login-shell")',
        );
        expect(desktopLoginShell()).toContain('export PATH="$1:$PATH"');
    });

    it("runs the bundled Happy Terminal through the packaged Electron executable", () => {
        const launcher = desktopHappyTerminalLauncher();

        expect(launcher).toContain("export ELECTRON_RUN_AS_NODE=1");
        expect(launcher).toContain('MacOS/Happy Nightly"');
        expect(launcher).toContain('"$bin_directory/../dist/main.js"');
    });

    it("packages the Happy local shell and complete Happy Terminal runtime", () => {
        expect(
            desktopBuilderConfiguration({
                buildResources: "/happy2/build",
                happy2NodeModules: "/staging/happy2/node_modules",
                output: "/staging/release",
                rigRuntime: "/staging/happy-terminal-runtime",
            }),
        ).toMatchObject({
            appId: "com.slopus.happy2.nightly",
            directories: { output: "/staging/release" },
            executableName: "Happy Nightly",
            extraResources: [
                { from: "/staging/happy2/node_modules", to: "node_modules" },
                { from: "/staging/happy-terminal-runtime", to: "happy-terminal-runtime" },
                {
                    from: "/staging/happy-terminal-runtime/node_modules",
                    to: "happy-terminal-runtime/node_modules",
                },
            ],
            files: ["dist/main.js", "dist/preload.cjs", "happy-terminal-main.mjs", "package.json"],
            productName: "Happy Nightly",
        });
    });
});
