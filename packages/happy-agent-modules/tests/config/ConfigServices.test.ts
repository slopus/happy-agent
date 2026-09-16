import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ConfigModule } from "../../sources/config/index.js";

describe("configuration-owned service authority", () => {
    it.runIf(process.platform === "linux")(
        "places private controls outside workspace inputs and exclusively leaves execution creation to the SDK",
        async () => {
            const directory = await mkdtemp(join(tmpdir(), "svc-config-"));
            try {
                const config = await ConfigModule.load(join(directory, "private"));
                const id = "a123456789012345678901234";
                const execution = config.serviceExecution(id);
                expect(execution).toEqual({
                    id,
                    directory: join(config.configuration.paths.agentHome, "services", id),
                });
                await config.prepareServiceControls();
                if (process.platform !== "win32")
                    expect((await stat(dirname(execution.directory))).mode & 0o777).toBe(0o700);
                await expect(stat(execution.directory)).rejects.toMatchObject({ code: "ENOENT" });
                for (const invalid of ["../escape", "a/another", "short", "a\n../escape"])
                    expect(() => config.serviceExecution(invalid)).toThrow();
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        },
    );

    it("uses the selected workspace's current root policy and gives generated runtime policy precedence", async () => {
        const directory = await mkdtemp(join(tmpdir(), "svc-net-"));
        try {
            let config = await ConfigModule.load(join(directory, "private"));
            const paths = config.configuration.paths;
            await mkdir(dirname(paths.globalConfigPath), { recursive: true });
            await writeFile(
                paths.globalConfigPath,
                '[network]\nallowed_domains = ["global.example"]\n',
                "utf8",
            );
            const first = join(directory, "first");
            const second = join(directory, "second");
            await mkdir(first);
            await mkdir(second);
            await writeFile(
                join(first, "happy.toml"),
                '[network]\nallowed_domains = ["first.example"]\nallowed_ports = [8443]\n',
                "utf8",
            );
            await writeFile(
                join(second, "rig.toml"),
                '[network]\nallowed_domains = ["obsolete.example"]\n',
                "utf8",
            );
            expect(await config.serviceNetworkPolicy(first)).toMatchObject({
                allowedDomains: [{ domain: "first.example", ports: [8443] }],
            });
            expect(await config.serviceNetworkPolicy(second)).toMatchObject({
                allowedDomains: [{ domain: "global.example", ports: [443] }],
            });
            await writeFile(
                join(first, "happy.toml"),
                '[network]\nallowed_domains = ["changed.example"]\n',
                "utf8",
            );
            expect(await config.serviceNetworkPolicy(first)).toMatchObject({
                allowedDomains: [{ domain: "changed.example", ports: [443] }],
            });
            await mkdir(dirname(paths.runtimeConfigPath), { recursive: true });
            await writeFile(
                paths.runtimeConfigPath,
                '[network]\nallowed_domains = ["runtime.example"]\n',
                "utf8",
            );
            config = await ConfigModule.load(join(directory, "private"));
            expect(await config.serviceNetworkPolicy(first)).toMatchObject({
                allowedDomains: [{ domain: "runtime.example", ports: [443] }],
            });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
