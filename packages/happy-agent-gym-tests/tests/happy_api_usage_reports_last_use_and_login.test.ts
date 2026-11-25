import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MessageMode } from "@slopus/happy-agent-client";
import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const running: AgentGym[] = [];
const folders: string[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
    await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const modelId = "openai/gpt-6.1-sol";
const mode: MessageMode = {
    providerId: "gym",
    modelId,
    effort: "medium",
    serviceTier: null,
    permissionMode: "auto",
};

function jwt(claims: Record<string, unknown>): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "none" })}.${part(claims)}.SECRET_SIGNATURE`;
}

it("reports when an account was last used and how its login stands, across a restart", async () => {
    const folder = await mkdtemp(join(tmpdir(), "gym-login-"));
    folders.push(folder);
    const authFile = join(folder, "auth.json");
    await writeFile(
        authFile,
        JSON.stringify({
            tokens: {
                access_token: jwt({ exp: 1_900_000_000, email: "SECRET_EMAIL" }),
                refresh_token: "SECRET_REFRESH_TOKEN",
            },
            last_refresh: "2026-11-24T08:00:00.000Z",
        }),
    );
    const gym = await createAgentGym({
        routeConfiguredProviders: true,
        providerIds: ["gym"],
        models: [
            {
                id: modelId,
                providerId: "gym",
                name: "Fixture model",
                defaultEffort: "medium",
                effortLevels: ["medium"],
            },
        ],
        config: `[providers]
default_enable = false
[providers.gym]
type = "codex"
enabled = true
credential_isolation = true
auth_file = "${authFile}"
[providers.bedrock]
type = "bedrock"
region = "us-east-1"
`,
        inference: [{ providerId: "gym", content: [{ type: "text", text: "Done." }] }],
    });
    running.push(gym);
    const account = async (providerId: string) =>
        (await gym.client.getUsage()).providers?.find((entry) => entry.providerId === providerId);
    const login = {
        refreshedAt: Date.parse("2026-11-24T08:00:00.000Z"),
        expiresAt: 1_900_000_000_000,
        refreshError: null,
    };

    expect(await account("gym")).toMatchObject({ lastUsedAt: null, login });
    const bedrock = await account("bedrock");
    expect(bedrock).not.toHaveProperty("lastUsedAt");
    expect(bedrock).not.toHaveProperty("login");

    const before = Date.now();
    await gym.send("Check the build.", mode);
    // The published client predates these fields, so they are read without its types.
    const used = await gym.waitUntil(async () => {
        const entry: object | undefined = await account("gym");
        return entry !== undefined && "lastUsedAt" in entry && typeof entry.lastUsedAt === "number"
            ? entry.lastUsedAt
            : undefined;
    }, "the account that answered to report its last use");
    expect(used).toBeGreaterThanOrEqual(before);
    const events = (await gym.client.getEvents({ limit: 1000 })).events;
    expect(events).toContainEqual(
        expect.objectContaining({
            type: "provider.usage.updated",
            payload: expect.objectContaining({ providerId: "gym", lastUsedAt: used, login }),
        }),
    );
    expect(JSON.stringify(events)).not.toContain("SECRET");
    expect(JSON.stringify(await gym.client.getUsage())).not.toContain("SECRET");

    await gym.restart();
    expect(await account("gym")).toMatchObject({ lastUsedAt: used, login });
    expect(gym.inference.unscripted).toEqual([]);
    expect(gym.errors).toEqual([]);
}, 60_000);
