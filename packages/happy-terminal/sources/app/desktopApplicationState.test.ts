import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { desktopApplicationName } from "./desktopApplicationRuntime.js";
import { desktopApplicationResolve } from "./desktopApplicationState.js";

describe("desktopApplicationResolve", () => {
    let temporaryRoot: string | undefined;

    afterEach(async () => {
        if (temporaryRoot) await rm(temporaryRoot, { force: true, recursive: true });
        temporaryRoot = undefined;
    });

    it("requires both the Happy app and its embedded Happy Terminal runtime", async () => {
        temporaryRoot = await mkdtemp(join(tmpdir(), "happy-terminal-desktop-state-"));
        const architectureDirectory = process.arch === "arm64" ? "mac-arm64" : "mac";
        const application = join(
            temporaryRoot,
            architectureDirectory,
            `${desktopApplicationName}.app`,
        );
        const contents = join(application, "Contents");
        await mkdir(join(contents, "MacOS"), { recursive: true });
        await writeFile(join(contents, "MacOS", desktopApplicationName), "");

        await expect(desktopApplicationResolve(temporaryRoot)).resolves.toBeUndefined();

        await mkdir(join(contents, "Resources", "happy-terminal-runtime", "bin"), {
            recursive: true,
        });
        await mkdir(join(contents, "Resources", "happy-terminal-runtime", "dist"), {
            recursive: true,
        });
        await mkdir(join(contents, "Resources", "happy-terminal-runtime", "node_modules"), {
            recursive: true,
        });
        await writeFile(join(contents, "Resources", "app.asar"), "");
        await writeFile(
            join(contents, "Resources", "happy-terminal-runtime", "bin", "happy-terminal"),
            "",
        );
        await writeFile(
            join(contents, "Resources", "happy-terminal-runtime", "dist", "main.js"),
            "",
        );

        await expect(desktopApplicationResolve(temporaryRoot)).resolves.toBe(application);
    });
});
