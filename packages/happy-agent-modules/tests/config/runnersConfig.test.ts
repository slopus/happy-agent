import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";

const BUILD = "b".repeat(43);
const GPU = "g".repeat(43);
const API = "a".repeat(43);
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** Load an installation whose machine `happy.toml` holds `source`. */
async function load(source: string): Promise<ConfigModule> {
    const root = await mkdtemp(join(tmpdir(), "happy-agent-runners-config-"));
    roots.push(root);
    const directory = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "happy.toml"), source);
    return await ConfigModule.load(join(root, ".happy"));
}

describe("runner configuration", () => {
    it("has no runners unless they are configured", async () => {
        expect((await load("")).runners).toEqual({ entries: {} });
    });

    it("makes a single runner the default", async () => {
        const config = await load(`[runners.build-box]\nname = "Build box"\ntoken = "${BUILD}"\n`);

        expect(config.runners).toEqual({
            defaultId: "build-box",
            entries: { "build-box": { name: "Build box", token: BUILD } },
        });
    });

    it("requires a default among several, and it must be one of them", async () => {
        const two =
            `[runners.build-box]\nname = "Build box"\ntoken = "${BUILD}"\n` +
            `[runners.gpu]\nname = "GPU"\ntoken = "${GPU}"\n`;

        await expect(load(two)).rejects.toThrow("runners.default must name the default runner");
        await expect(load(`[runners]\ndefault = "nope"\n${two}`)).rejects.toThrow(
            'runners.default names "nope", which is not a configured runner.',
        );
        expect((await load(`[runners]\ndefault = "gpu"\n${two}`)).runners.defaultId).toBe("gpu");
    });

    it("refuses a token shared with the API or another runner", async () => {
        await expect(
            load(
                `[api]\ntoken = "${API}"\n[runners.build-box]\nname = "Build box"\ntoken = "${API}"\n`,
            ),
        ).rejects.toThrow("runners.build-box.token must differ");
        await expect(
            load(
                `[runners]\ndefault = "a"\n[runners.a]\nname = "A"\ntoken = "${BUILD}"\n` +
                    `[runners.b]\nname = "B"\ntoken = "${BUILD}"\n`,
            ),
        ).rejects.toThrow("runners.b.token must differ");
    });

    it("explains malformed entries in plain words", async () => {
        await expect(load(`[runners.Build]\nname = "x"\ntoken = "${BUILD}"\n`)).rejects.toThrow(
            'Runner ID "Build" must start with a lowercase letter',
        );
        await expect(
            load(`[runners.build-box]\nname = "Build box"\ntoken = "short"\n`),
        ).rejects.toThrow("runners.build-box.token must be 43 characters");
        await expect(
            load(`[runners.build-box]\nname = "Build box"\ntoken = "${BUILD}"\nport = 1\n`),
        ).rejects.toThrow("runners.build-box.port is not a runner setting.");
    });
});
