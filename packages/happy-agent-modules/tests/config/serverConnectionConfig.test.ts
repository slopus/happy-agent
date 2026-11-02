import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigModule } from "../../sources/config/index.js";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(source = "") {
    const root = await mkdtemp(join(tmpdir(), "server-config-"));
    roots.push(root);
    const folder = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "happy.toml"), source);
    const home = join(root, ".happy");
    await mkdir(join(home, "agent"), { recursive: true });
    return { home, config: await ConfigModule.load(home) };
}

describe("server connections by URL in configuration", () => {
    it("keeps a URL connection added at runtime across a reload", async () => {
        const f = await fixture();
        await f.config.updateRuntimeConnection(createRootContext(), "added", {
            name: "Added",
            url: "https://added.example.com/",
        });
        expect((await ConfigModule.load(f.home)).connections).toEqual({
            added: { name: "Added", url: "https://added.example.com/" },
        });
    });

    it("refuses a URL connection in team mode", async () => {
        await expect(
            fixture(
                '[feature.team]\nenabled = true\nworkos_organization_id = "org_test123"\nowner_workos_user_id = "user_owner123"\n[connections.team]\nname = "T"\nurl = "https://t.example.com/"\n',
            ),
        ).rejects.toThrow("A server connection by URL needs standalone mode.");
    });

    it("creates the installation's identity once and keeps it", async () => {
        const f = await fixture();
        expect(f.config.loadedInstanceId).toBeUndefined();
        const id = await f.config.instanceId();
        expect(id).toMatch(/^[a-z][a-z0-9]{23}$/u);
        expect(f.config.loadedInstanceId).toBe(id);
        expect((await readFile(join(f.home, "agent", "instance-id"), "utf8")).trim()).toBe(id);
        await expect((await ConfigModule.load(f.home)).instanceId()).resolves.toBe(id);
    });
});
