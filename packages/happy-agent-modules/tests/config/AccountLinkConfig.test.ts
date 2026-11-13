import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";

const temporaryDirectories: string[] = [];
const configDirectory = process.platform === "darwin" ? "Happy/Config" : "happy/config";

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("account link configuration", () => {
    it("is off and has no origins by default", async () => {
        const root = await temporaryRoot();
        const config = await ConfigModule.load(join(root, ".happy"));

        expect(config.configuration.values.feature.accountLink).toEqual({ enabled: false });
        expect(config.accountLink).toBeUndefined();
    });

    it("loads both origins from machine configuration and reports unknown keys", async () => {
        const root = await temporaryRoot();
        await writeGlobal(root, [
            "[feature.account_link]",
            "enabled = true",
            'accounts_url = "https://Accounts.Example.com/"',
            'relay_url = "http://127.0.0.1:8787"',
            "extra = 1",
        ]);

        const config = await ConfigModule.load(join(root, ".happy"));

        expect(config.accountLink).toEqual({
            accountsUrl: "https://accounts.example.com",
            relayUrl: "http://127.0.0.1:8787",
        });
        expect(config.configuration.provenance["feature.accountLink.accountsUrl"]).toBe("global");
        expect(config.configuration.sources.global.unknownSettings).toEqual([
            "feature.account_link.extra",
        ]);
    });

    it("stays inactive when it is enabled without both origins, or configured but not enabled", async () => {
        const missingRelay = await temporaryRoot();
        await writeGlobal(missingRelay, [
            "[feature.account_link]",
            "enabled = true",
            'accounts_url = "https://accounts.example.com"',
        ]);
        expect((await ConfigModule.load(join(missingRelay, ".happy"))).accountLink).toBeUndefined();

        const notEnabled = await temporaryRoot();
        await writeGlobal(notEnabled, [
            "[feature.account_link]",
            'accounts_url = "https://accounts.example.com"',
            'relay_url = "https://relay.accounts.example.com"',
        ]);
        expect((await ConfigModule.load(join(notEnabled, ".happy"))).accountLink).toBeUndefined();
    });

    it.each([
        ["http://accounts.example.com", "must use HTTPS, or HTTP on a loopback address"],
        ["https://accounts.example.com/base", "must be an origin without a path"],
        ["https://user:secret@accounts.example.com", "must be an origin without a path"],
        ["accounts.example.com", "must be an absolute URL"],
    ])("rejects the accounts origin %s", async (url, message) => {
        const root = await temporaryRoot();
        await writeGlobal(root, ["[feature.account_link]", `accounts_url = "${url}"`]);

        await expect(ConfigModule.load(join(root, ".happy"))).rejects.toThrow(message);
    });

    it("does not let a project configuration link the machine or choose its relay", async () => {
        const root = await temporaryRoot();
        const previous = process.cwd();
        await writeFile(
            join(root, "happy.toml"),
            [
                "[feature.account_link]",
                "enabled = true",
                'accounts_url = "https://accounts.attacker.example"',
                'relay_url = "https://relay.attacker.example"',
            ].join("\n"),
        );
        process.chdir(root);
        try {
            const config = await ConfigModule.load(join(root, ".happy"));
            expect(config.accountLink).toBeUndefined();
            expect(config.configuration.values.feature.accountLink).toEqual({ enabled: false });
        } finally {
            process.chdir(previous);
        }
    });
});

async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "happy-agent-config-account-link-"));
    temporaryDirectories.push(root);
    return root;
}

async function writeGlobal(root: string, lines: readonly string[]): Promise<void> {
    await mkdir(join(root, configDirectory), { recursive: true });
    await writeFile(join(root, configDirectory, "happy.toml"), lines.join("\n"));
}
