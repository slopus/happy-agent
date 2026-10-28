import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { accountHomeRoutes } from "../../sources/providerRoutes/impl/accountHomeRoutes.js";

const homes: string[] = [];

afterEach(async () => {
    await Promise.all(homes.splice(0).map(async (home) => await rm(home, { recursive: true })));
});

/** A throwaway home holding fake account folders; nothing in it is a real sign-in. */
async function home(files: Record<string, string>): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "homes-"));
    homes.push(path);
    for (const [file, contents] of Object.entries(files)) {
        await mkdir(join(path, file, ".."), { recursive: true });
        await writeFile(join(path, file), contents);
    }
    return path;
}

function fakeIdToken(claims: object): string {
    return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

const FILES = {
    ".claude/.claude.json": JSON.stringify({ oauthAccount: { emailAddress: "main@example.com" } }),
    ".claude-work/.claude.json": JSON.stringify({
        oauthAccount: { emailAddress: "ada@work.example" },
    }),
    ".claude-linux/.credentials.json": '{"claudeAiOauth":{"accessToken":"sk-ant-secret"}}',
    ".claude-code-router/config.json": "{}",
    ".claude-empty/settings.json": "{}",
    ".codex/auth.json": "{}",
    ".codex-personal/auth.json": JSON.stringify({
        tokens: {
            id_token: fakeIdToken({
                email: "ada@home.example",
                "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
            }),
            access_token: "codex-secret",
        },
    }),
    ".codex-api/auth.json": JSON.stringify({ OPENAI_API_KEY: "sk-openai-secret" }),
    ".codex-blank/auth.json": "{}",
};

describe("other Claude and Codex account folders", () => {
    it("offers each signed-in folder beside the default one, by account, without its secrets", async () => {
        const path = await home(FILES);
        const routes = await accountHomeRoutes(
            { platform: "darwin", env: { HOME: path }, programDirectories: [] },
            () => null,
            () => undefined,
        );

        expect(
            routes.map((route) => [route.id, route.status, route.billing, route.account?.label]),
        ).toEqual([
            ["claude_home:.claude-linux", "ready", "subscription", ".claude-linux"],
            // The login itself is in the keychain, which detection never reads.
            ["claude_home:.claude-work", "unknown", "subscription", "ada@work.example"],
            ["codex_home:.codex-api", "ready", "pay_per_token", ".codex-api"],
            ["codex_home:.codex-personal", "ready", "subscription", "ada@home.example"],
        ]);
        expect(routes[1]).toMatchObject({
            kind: "direct",
            name: "Claude Code (~/.claude-work)",
            vendors: ["Anthropic"],
            provider: {
                id: "claude_work",
                table: {
                    type: "claude",
                    name: "Claude (~/.claude-work)",
                    config_dir: join(path, ".claude-work"),
                },
            },
        });
        expect(routes[3]).toMatchObject({
            account: { email: "ada@home.example", plan: "Plus" },
            provider: {
                id: "codex_personal",
                table: { type: "codex", auth_file: join(path, ".codex-personal", "auth.json") },
            },
        });
        expect(JSON.stringify(routes)).not.toMatch(/secret/u);
    });

    it("skips the folder already in use and names a provider already set up with a folder", async () => {
        const path = await home(FILES);
        const routes = await accountHomeRoutes(
            {
                platform: "linux",
                env: { HOME: path, CLAUDE_CONFIG_DIR: join(path, ".claude-work") },
                programDirectories: [],
            },
            (type) => [{ id: `${type}-model`, vendor: type }],
            (type, folder) =>
                type === "codex" && folder === join(path, ".codex-api")
                    ? "codex_api_key"
                    : undefined,
        );

        expect(routes.map((route) => route.id)).toEqual([
            "claude_home:.claude-linux",
            "codex_home:.codex-api",
            "codex_home:.codex-personal",
        ]);
        expect(routes[1]).toMatchObject({
            models: [{ id: "codex-model", vendor: "codex" }],
            provider: { id: "codex_api_key" },
        });
    });

    it("finds nothing in a home without other account folders", async () => {
        const path = await home({ ".claude/.claude.json": "{}" });
        await expect(
            accountHomeRoutes(
                { platform: "darwin", env: { HOME: path }, programDirectories: [] },
                () => null,
                () => undefined,
            ),
        ).resolves.toEqual([]);
    });
});
