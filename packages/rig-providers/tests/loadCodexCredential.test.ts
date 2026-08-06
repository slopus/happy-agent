import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadCodexCredential } from "@/vendors/codex/loadCodexCredential.js";
import { tryLoadCredentials } from "@/vendors/tryLoadCredentials.js";

const tempDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        tempDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("loadCodexCredential", () => {
    it("loads the API key selected by the native Codex login", async () => {
        const authFile = await writeAuthFile({
            auth_mode: "apikey",
            OPENAI_API_KEY: "native",
        });

        const credential = await loadCodexCredential({ authFile, env: {} });

        expect(credential).toMatchObject({
            credential: { apiKey: "native" },
            name: "codex-api-key",
        });
    });

    it("does not use a stale API key when the native login selects a session", async () => {
        const authFile = await writeAuthFile({
            auth_mode: "chatgpt",
            OPENAI_API_KEY: "stale",
            tokens: { access_token: "session" },
        });

        const credential = await loadCodexCredential({ authFile, env: {} });

        expect(credential).toMatchObject({
            credential: { accessToken: "session" },
            name: "codex-session",
        });
    });

    it("does not fall back to stale session tokens when the native login selects an API key", async () => {
        const authFile = await writeAuthFile({
            auth_mode: "apikey",
            OPENAI_API_KEY: "",
            tokens: { access_token: "stale" },
        });

        await expect(loadCodexCredential({ authFile, env: {} })).resolves.toBeNull();
    });

    it("prefers explicit and environment API keys over the native auth file", async () => {
        const authFile = await writeAuthFile({
            auth_mode: "apikey",
            OPENAI_API_KEY: "native",
        });

        await expect(
            loadCodexCredential({
                apiKey: "explicit",
                authFile,
                env: { OPENAI_API_KEY: "environment" },
            }),
        ).resolves.toMatchObject({ credential: { apiKey: "explicit" } });
        await expect(
            loadCodexCredential({
                authFile,
                env: { OPENAI_API_KEY: "environment" },
            }),
        ).resolves.toMatchObject({ credential: { apiKey: "environment" } });
    });

    it("discovers exactly one Codex credential from the native auth file", async () => {
        const authFile = await writeAuthFile({
            auth_mode: "apikey",
            OPENAI_API_KEY: "native",
        });

        const credentials = await tryLoadCredentials({ codexAuthFile: authFile, env: {} });

        expect(credentials.filter((credential) => credential.name.startsWith("codex-"))).toEqual([
            expect.objectContaining({
                credential: { apiKey: "native" },
                name: "codex-api-key",
            }),
        ]);
    });
});

describe("loadCodexCredential with a real Codex auth file", () => {
    /*
     * Codex nulls out whichever half of the file it is not using. Every fixture
     * above writes strings, so a schema that rejects null passes the suite while
     * failing on every real ChatGPT login.
     */
    it("loads the session credential when Codex nulls OPENAI_API_KEY", async () => {
        const authFile = await writeAuthFile({
            auth_mode: "chatgpt",
            last_refresh: "2026-08-05T00:00:00.000Z",
            OPENAI_API_KEY: null,
            tokens: {
                access_token: "session-token",
                account_id: "account-1",
                id_token: "id-token",
                refresh_token: "refresh-token",
            },
        });

        const credential = await loadCodexCredential({ authFile, env: {} });

        expect(credential).toMatchObject({ name: "codex-session" });
    });

    it("loads the API key when Codex nulls tokens", async () => {
        const authFile = await writeAuthFile({
            auth_mode: "apikey",
            OPENAI_API_KEY: "native",
            tokens: null,
        });

        const credential = await loadCodexCredential({ authFile, env: {} });

        expect(credential).toMatchObject({
            credential: { apiKey: "native" },
            name: "codex-api-key",
        });
    });
});

async function writeAuthFile(contents: Record<string, unknown>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-codex-auth-"));
    tempDirectories.push(root);
    const authFile = join(root, "auth.json");
    await writeFile(authFile, JSON.stringify(contents));
    return authFile;
}
