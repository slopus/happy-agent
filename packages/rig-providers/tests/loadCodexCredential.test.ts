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
            OPENAI_API_KEY: "native-api-key",
        });

        const credential = await loadCodexCredential({ authFile, env: {} });

        expect(credential).toMatchObject({
            credential: { apiKey: "native-api-key" },
            name: "codex-api-key",
        });
    });

    it("does not use a stale API key when the native login selects a session", async () => {
        const authFile = await writeAuthFile({
            auth_mode: "chatgpt",
            OPENAI_API_KEY: "stale-api-key",
            tokens: { access_token: "session-token" },
        });

        const credential = await loadCodexCredential({ authFile, env: {} });

        expect(credential).toMatchObject({
            credential: { accessToken: "session-token" },
            name: "codex-session",
        });
    });

    it("does not fall back to stale session tokens when the native login selects an API key", async () => {
        const authFile = await writeAuthFile({
            auth_mode: "apikey",
            OPENAI_API_KEY: "",
            tokens: { access_token: "stale-session-token" },
        });

        await expect(loadCodexCredential({ authFile, env: {} })).resolves.toBeNull();
    });

    it("prefers explicit and environment API keys over the native auth file", async () => {
        const authFile = await writeAuthFile({
            auth_mode: "apikey",
            OPENAI_API_KEY: "native-api-key",
        });

        await expect(
            loadCodexCredential({
                apiKey: "explicit-api-key",
                authFile,
                env: { OPENAI_API_KEY: "environment-api-key" },
            }),
        ).resolves.toMatchObject({ credential: { apiKey: "explicit-api-key" } });
        await expect(
            loadCodexCredential({
                authFile,
                env: { OPENAI_API_KEY: "environment-api-key" },
            }),
        ).resolves.toMatchObject({ credential: { apiKey: "environment-api-key" } });
    });

    it("discovers exactly one Codex credential from the native auth file", async () => {
        const authFile = await writeAuthFile({
            auth_mode: "apikey",
            OPENAI_API_KEY: "native-api-key",
        });

        const credentials = await tryLoadCredentials({ codexAuthFile: authFile, env: {} });

        expect(credentials.filter((credential) => credential.name.startsWith("codex-"))).toEqual([
            expect.objectContaining({
                credential: { apiKey: "native-api-key" },
                name: "codex-api-key",
            }),
        ]);
    });
});

async function writeAuthFile(contents: Record<string, unknown>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-codex-auth-"));
    tempDirectories.push(root);
    const authFile = join(root, "auth.json");
    await writeFile(authFile, JSON.stringify(contents));
    return authFile;
}
