import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigModule } from "../../sources/config/ConfigModule.js";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A throwaway installation with these files written; absent text means no file. */
async function installation(files: {
    readonly happy?: string;
    readonly runtime?: string;
    readonly providers?: string;
}) {
    const root = await mkdtemp(join(tmpdir(), "provider-accounts-move-"));
    roots.push(root);
    const configHome = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    const agentHome = join(root, ".happy", "agent");
    await mkdir(configHome, { recursive: true });
    await mkdir(agentHome, { recursive: true });
    const paths = {
        happy: join(configHome, "happy.toml"),
        runtime: join(agentHome, "runtime.toml"),
        providers: join(agentHome, "providers.toml"),
    };
    if (files.happy !== undefined) await writeFile(paths.happy, files.happy);
    if (files.runtime !== undefined) await writeFile(paths.runtime, files.runtime);
    if (files.providers !== undefined) await writeFile(paths.providers, files.providers);
    const backups = async () =>
        (await readdir(configHome)).filter((name) => name.startsWith("happy.toml.bak-"));
    const read = async (path: string) => await readFile(path, "utf8").catch(() => undefined);
    return { root, configHome, paths, backups, read, load: () => load(root) };
}

async function load(root: string): Promise<ConfigModule> {
    return await ConfigModule.load(join(root, ".happy"));
}

function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

const HAPPY = [
    "# My settings, written by hand",
    "[defaults]",
    'provider = "codex" # keep this one',
    "",
    "[providers]",
    "default_enable = false",
    "",
    "# Work",
    "[providers.codex_work]",
    'type = "codex"',
    'name = "Work"',
    'api_key = "sk-from-happy"',
    "",
    "[providers.bedrock]",
    'region = "us-west-2"',
    "enabled = false",
    "",
    "# Settings below stay",
    "[settings]",
    "show_usage = true",
    "",
].join("\n");

const HAPPY_WITHOUT_ACCOUNTS = [
    "# My settings, written by hand",
    "[defaults]",
    'provider = "codex" # keep this one',
    "",
    "[providers]",
    "default_enable = false",
    "",
    "# Work",
    "# Settings below stay",
    "[settings]",
    "show_usage = true",
    "",
].join("\n");

describe("moving accounts into providers.toml", () => {
    it("keeps every account's configuration on the first move, and happy.toml byte for byte", async () => {
        const install = await installation({
            happy: HAPPY,
            runtime: [
                "[settings]",
                "compact_completed_turns = false",
                "",
                "[providers.codex_work]",
                'type = "codex"',
                'name = "Renamed by the daemon"',
                "auto_enable = true",
                "",
                "[providers.bedrock]",
                "enabled = true",
                "",
            ].join("\n"),
        });

        const config = await install.load();

        // runtime.toml's keys win over happy.toml's, key by key, exactly as before the move.
        expect(config.configuration.values.providers.codex_work).toMatchObject({
            type: "codex",
            name: "Renamed by the daemon",
            apiKey: "sk-from-happy",
            autoEnable: true,
        });
        expect(config.configuration.values.providers.bedrock).toMatchObject({
            region: "us-west-2",
            enabled: true,
        });
        expect(config.configuration.values.settings.showUsage).toBe(true);
        expect(config.configuration.values.settings.compactCompletedTurns).toBe(false);
        expect(config.configuration.values.providerDefaultEnable).toBe(false);

        expect(await install.read(install.paths.happy)).toBe(HAPPY_WITHOUT_ACCOUNTS);
        const [backup, ...more] = await install.backups();
        expect(more).toEqual([]);
        expect(await install.read(join(install.configHome, backup!))).toBe(HAPPY);
        expect((await stat(join(install.configHome, backup!))).mode & 0o777).toBe(0o600);
        expect((await stat(install.paths.providers)).mode & 0o777).toBe(0o600);
        const providers = await install.read(install.paths.providers);
        expect(providers).toContain("sk-from-happy");
        expect(providers).not.toContain("pending_happy_toml_move");
        expect(await install.read(install.paths.runtime)).toBe(
            "[settings]\ncompact_completed_turns = false\n",
        );

        // The next start finds nothing left to move and changes nothing.
        const files = await Promise.all(Object.values(install.paths).map(install.read));
        const again = await install.load();
        expect(again.configuration.values.providers).toEqual(config.configuration.values.providers);
        expect(await Promise.all(Object.values(install.paths).map(install.read))).toEqual(files);
        expect(await install.backups()).toHaveLength(1);
    });

    it("finishes a move stopped before happy.toml was rewritten, without merging again", async () => {
        const happy = '[providers.codex_work]\ntype = "codex"\nname = "Written"\n';
        const install = await installation({
            happy,
            // What the stopped start wrote: the merge, then the daemon changed the account.
            providers: [
                "[pending_happy_toml_move]",
                `sha256 = "${sha256(happy)}"`,
                "",
                "[providers.codex_work]",
                'type = "codex"',
                'name = "Changed since"',
                "",
            ].join("\n"),
            // And runtime.toml still holds its old copy of the account.
            runtime: '[providers.codex_work]\ntype = "codex"\nname = "Old runtime copy"\n',
        });

        const config = await install.load();

        expect(config.configuration.values.providers.codex_work?.name).toBe("Changed since");
        expect(await install.read(install.paths.happy)).toBe("");
        expect(await install.read(install.paths.runtime)).not.toContain("codex_work");
        expect(await install.read(install.paths.providers)).not.toContain("pending");
        expect(await install.backups()).toEqual([]);
    });

    it("imports a restored happy.toml again rather than dropping its accounts", async () => {
        const happy = '[providers.codex_work]\ntype = "codex"\nname = "Restored"\nenabled = true\n';
        const install = await installation({
            happy,
            // A finished earlier move: no marker, the account since signed in and switched off.
            providers: [
                "[providers.codex_work]",
                'type = "codex"',
                'name = "Work"',
                "enabled = false",
                'auth_file = "/accounts/codex_work/attempt/auth.json"',
                "credential_isolation = true",
                "",
            ].join("\n"),
        });

        const config = await install.load();

        // The person's keys win; the account keeps its other keys and its enablement.
        expect(config.configuration.values.providers.codex_work).toMatchObject({
            name: "Restored",
            enabled: false,
            authFile: "/accounts/codex_work/attempt/auth.json",
            credentialIsolation: true,
        });
        expect(await install.read(install.paths.happy)).toBe("");
        expect(await install.backups()).toHaveLength(1);
    });

    it("leaves accounts it cannot move as text in happy.toml, and says why", async () => {
        const happy = '# inline\nproviders = { work = { type = "codex", name = "Inline" } }\n';
        const install = await installation({ happy });

        const config = await install.load();

        expect(config.configuration.values.providers.work?.name).toBe("Inline");
        expect(await install.read(install.paths.happy)).toBe(happy);
        expect(await install.read(install.paths.providers)).toBeUndefined();
        expect(await install.backups()).toEqual([]);
        const warn = vi.fn();
        config.beforeStart({ log: { warn } } as unknown as Context);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain("inline tables or dotted keys");
    });
});
