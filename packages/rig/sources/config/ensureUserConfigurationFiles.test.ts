import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureUserConfigurationFiles } from "./ensureUserConfigurationFiles.js";
import { parseConfigToml } from "./parseConfigToml.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("ensureUserConfigurationFiles", () => {
    it("creates a commented Happy template and empty global markdown files", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-user-config-"));
        temporaryDirectories.push(root);
        const configPath = join(root, "Happy", "Config", "happy.toml");
        const agentsPath = join(root, "Happy", "Config", "AGENTS.md");
        const securityPath = join(root, "Happy", "Config", "SECURITY.md");

        await ensureUserConfigurationFiles({ agentsPath, configPath, securityPath });

        const template = await readFile(configPath, "utf8");
        expect(parseConfigToml(template)).toEqual({});
        expect(
            template
                .split("\n")
                .filter((line) => line.trim().length > 0)
                .every((line) => line.startsWith("#")),
        ).toBe(true);
        expect(template).toContain("# [defaults]");
        expect(template).toContain("# [mcp_servers.remote]");
        expect(parseConfigToml(uncommentTemplateSettings(template, "image"))).toMatchObject({
            docker: { image: "my-project-dev:latest" },
        });
        expect(parseConfigToml(uncommentTemplateSettings(template, "container"))).toMatchObject({
            docker: { container: "existing-container" },
        });
        await expect(readFile(agentsPath, "utf8")).resolves.toBe("");
        await expect(readFile(securityPath, "utf8")).resolves.toBe("");
        expect((await stat(join(root, "Happy"))).mode & 0o777).toBe(0o777 & ~process.umask());
        expect((await stat(join(root, "Happy", "Config"))).mode & 0o777).toBe(0o700);
        expect((await stat(configPath)).mode & 0o777).toBe(0o600);
        expect((await stat(agentsPath)).mode & 0o777).toBe(0o600);
        expect((await stat(securityPath)).mode & 0o777).toBe(0o600);
    });

    it("creates each file exactly once when first-start initialization races", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-racing-user-config-"));
        temporaryDirectories.push(root);
        const configPath = join(root, "Config", "happy.toml");
        const agentsPath = join(root, "Config", "AGENTS.md");
        const securityPath = join(root, "Config", "SECURITY.md");

        await Promise.all(
            Array.from({ length: 8 }, () =>
                ensureUserConfigurationFiles({ agentsPath, configPath, securityPath }),
            ),
        );

        expect(parseConfigToml(await readFile(configPath, "utf8"))).toEqual({});
        await expect(readFile(agentsPath, "utf8")).resolves.toBe("");
        await expect(readFile(securityPath, "utf8")).resolves.toBe("");
    });

    it("preserves both files when they already exist", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-existing-user-config-"));
        temporaryDirectories.push(root);
        const configPath = join(root, "happy.toml");
        const agentsPath = join(root, "AGENTS.md");
        const securityPath = join(root, "SECURITY.md");
        await writeFile(configPath, "existing config\n");
        await writeFile(agentsPath, "existing instructions\n");
        await writeFile(securityPath, "existing policy\n");

        await Promise.all([
            ensureUserConfigurationFiles({ agentsPath, configPath, securityPath }),
            ensureUserConfigurationFiles({ agentsPath, configPath, securityPath }),
        ]);

        await expect(readFile(configPath, "utf8")).resolves.toBe("existing config\n");
        await expect(readFile(agentsPath, "utf8")).resolves.toBe("existing instructions\n");
        await expect(readFile(securityPath, "utf8")).resolves.toBe("existing policy\n");
    });
});

function uncommentTemplateSettings(template: string, dockerSource: "container" | "image"): string {
    const imageOnlySettings =
        dockerSource === "container"
            ? new Set([
                  '# name = "rig-session"',
                  '# env = { NODE_ENV = "development" }',
                  '# mounts = [{ source = "/host/path", target = "/container/path", read_only = true }]',
              ])
            : new Set<string>();
    return template
        .split("\n")
        .filter(
            (line) =>
                line !==
                    (dockerSource === "image"
                        ? '# container = "existing-container"'
                        : '# image = "my-project-dev:latest"') && !imageOnlySettings.has(line),
        )
        .flatMap((line) => {
            const commented = /^# (\[.+\]|[a-z0-9_]+ = .+)$/u.exec(line);
            return commented === null ? [] : [commented[1]!];
        })
        .join("\n");
}
