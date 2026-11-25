import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigModule, type ProviderLoginChange } from "../../sources/config/index.js";

const folders: string[] = [];
afterEach(async () => {
    await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const GROK_SCOPE = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";

/** A configuration whose vendor CLI homes are empty folders of its own, never the machine's. */
async function load(
    machineFile: string | ((root: string) => string),
): Promise<{ config: ConfigModule; root: string }> {
    const root = await mkdtemp(join(tmpdir(), "provider-login-"));
    folders.push(root);
    const folder = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    await mkdir(folder, { recursive: true });
    await writeFile(
        join(folder, "happy.toml"),
        typeof machineFile === "string" ? machineFile : machineFile(root),
    );
    const config = await ConfigModule.load(join(root, ".happy"), {
        environment: {
            HOME: join(root, "home"),
            CODEX_HOME: join(root, "codex-home"),
            GROK_HOME: join(root, "grok-home"),
            CLAUDE_CONFIG_DIR: join(root, "claude-home"),
            CLAUDE_CODE_OAUTH_TOKEN: "",
            XAI_API_KEY: "",
        },
    });
    return { config, root };
}

function jwt(claims: Record<string, unknown>): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "none" })}.${part(claims)}.SECRET_SIGNATURE`;
}

describe("an account's stored login", () => {
    it("reads renewal and expiry from each vendor's credential, and nothing else", async () => {
        const { config, root } = await load((root) =>
            [
                "[providers.codex_work]",
                'type = "codex"',
                `auth_file = "${join(root, "codex", "auth.json")}"`,
                "",
                "[providers.grok_work]",
                'type = "grok"',
                `auth_file = "${join(root, "grok", "auth.json")}"`,
                "",
                "[providers.claude_work]",
                'type = "claude"',
                `config_dir = "${join(root, "claude")}"`,
            ].join("\n"),
        );
        for (const folder of ["codex", "grok", "claude"]) {
            await mkdir(join(root, folder), { recursive: true });
        }
        await writeFile(
            join(root, "codex", "auth.json"),
            JSON.stringify({
                tokens: {
                    access_token: jwt({ exp: 1_800_000_000, sub: "SECRET_SUBJECT" }),
                    refresh_token: "SECRET_REFRESH",
                },
                last_refresh: "2026-11-20T10:00:00.000Z",
            }),
        );
        await writeFile(
            join(root, "grok", "auth.json"),
            JSON.stringify({
                [GROK_SCOPE]: {
                    key: "SECRET_GROK_KEY",
                    refresh_token: "SECRET_REFRESH",
                    expires_at: "2026-11-26T10:00:00.000Z",
                },
            }),
        );
        await writeFile(
            join(root, "claude", ".credentials.json"),
            JSON.stringify({
                claudeAiOauth: {
                    accessToken: "SECRET_CLAUDE",
                    refreshToken: "SECRET_REFRESH",
                    expiresAt: 1_790_000_000_000,
                },
            }),
        );

        const logins = {
            codex: await config.providerLogin("codex_work"),
            grok: await config.providerLogin("grok_work"),
            claude: await config.providerLogin("claude_work"),
        };

        expect(logins).toEqual({
            codex: {
                refreshedAt: Date.parse("2026-11-20T10:00:00.000Z"),
                expiresAt: 1_800_000_000_000,
            },
            grok: {
                refreshedAt: Math.trunc((await stat(join(root, "grok", "auth.json"))).mtimeMs),
                expiresAt: Date.parse("2026-11-26T10:00:00.000Z"),
            },
            claude: {
                refreshedAt: Math.trunc(
                    (await stat(join(root, "claude", ".credentials.json"))).mtimeMs,
                ),
                expiresAt: 1_790_000_000_000,
            },
        });
        expect(JSON.stringify(logins)).not.toContain("SECRET");
    });

    it("has none for keys and missing credentials, and nothing to say about a setup token", async () => {
        const { config, root } = await load((root) =>
            [
                "[providers.codex_key]",
                'type = "codex"',
                'api_key = "sk-configured"',
                "",
                "[providers.codex_isolated]",
                'type = "codex"',
                "credential_isolation = true",
                "",
                "[providers.grok_key_in_file]",
                'type = "grok"',
                `auth_file = "${join(root, "grok-key.json")}"`,
                "",
                "[providers.claude_token]",
                'type = "claude"',
                'oauth_token = "sk-ant-oat01-configured"',
                "",
                "[providers.bedrock]",
                'region = "us-east-1"',
            ].join("\n"),
        );
        await writeFile(
            join(root, "grok-key.json"),
            JSON.stringify({
                "xai::api_key": { key: "xai-key" },
                [GROK_SCOPE]: { key: "session", expires_at: "2026-11-26T10:00:00.000Z" },
            }),
        );

        expect(await config.providerLogin("codex")).toBeNull();
        expect(await config.providerLogin("codex_key")).toBeNull();
        expect(await config.providerLogin("codex_isolated")).toBeNull();
        expect(await config.providerLogin("grok_key_in_file")).toBeNull();
        expect(await config.providerLogin("claude_token")).toEqual({
            refreshedAt: null,
            expiresAt: null,
        });
        expect(await config.providerLogin("bedrock")).toBeUndefined();
        expect(await config.providerLogin("missing")).toBeUndefined();
    });

    it("finds the vendor program's own sign-in for an account without isolation", async () => {
        const { config, root } = await load("");
        await mkdir(join(root, "codex-home"), { recursive: true });
        await writeFile(
            join(root, "codex-home", "auth.json"),
            JSON.stringify({
                tokens: { access_token: jwt({ exp: 1_800_000_000 }) },
                last_refresh: "2026-11-21T00:00:00.000Z",
            }),
        );

        expect(await config.providerLogin("codex")).toEqual({
            refreshedAt: Date.parse("2026-11-21T00:00:00.000Z"),
            expiresAt: 1_800_000_000_000,
        });
    });

    it("tells login listeners when an account is given a new credential", async () => {
        const { config } = await load('[providers.claude_work]\ntype = "claude"\n');
        const changes: { providerId: string; change: ProviderLoginChange }[] = [];
        config.onProviderLoginChanged((providerId, change) => changes.push({ providerId, change }));

        await config.saveProviderSetupToken(
            createRootContext(),
            "claude_work",
            "sk-ant-oat01-a-new-token",
        );

        expect(changes).toEqual([{ providerId: "claude_work", change: { kind: "signed_in" } }]);
    });
});
