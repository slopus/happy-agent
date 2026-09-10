import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { AgentProviders, type AgentModel } from "@slopus/happy-agent-base";
import { HappyAgentClient } from "@slopus/happy-agent-client";
import { CodexApiKeyCredential, CodexProvider } from "@slopus/happy-providers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startHappyAgentDaemon, type HappyAgentDaemon } from "../sources/main.js";

const temporaryDirectories: string[] = [];
const CLIENT_ID = "client_01KZD3XE9YAFAMT0P8TD4HP73E";
const ORGANIZATION_ID = "org_test123";
const OWNER_WORKOS_USER_ID = "user_owner123";
const MEMBER_WORKOS_USER_ID = "user_member456";
let daemon: HappyAgentDaemon | undefined;

afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    vi.unstubAllGlobals();
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("team mode daemon", () => {
    it.each([false, true])(
        "combines installation completion (%s) with each member's own profile across restart",
        async (installationCompleted) => {
            const root = await mkdtemp(join(tmpdir(), "happy-agent-team-onboarding-"));
            temporaryDirectories.push(root);
            const happyHome = join(root, ".happy");
            const configPath = join(
                root,
                process.platform === "darwin" ? "Happy/Config" : "happy/config",
                "happy.toml",
            );
            await mkdir(dirname(configPath), { recursive: true });
            await writeFile(
                configPath,
                [
                    "[feature.team]",
                    "enabled = true",
                    'host = "127.0.0.1"',
                    "port = 0",
                    `workos_organization_id = "${ORGANIZATION_ID}"`,
                    `owner_workos_user_id = "${OWNER_WORKOS_USER_ID}"`,
                ].join("\n"),
            );
            const markerPath = join(happyHome, "agent", "onboarding-v0");
            if (installationCompleted) {
                await mkdir(dirname(markerPath), { recursive: true });
                await writeFile(markerPath, "complete\n");
            }

            const { privateKey, publicKey } = await generateKeyPair("RS256");
            const jwk = {
                ...(await exportJWK(publicKey)),
                alg: "RS256",
                kid: "team-daemon-test",
                use: "sig",
            };
            const nativeFetch = globalThis.fetch;
            vi.stubGlobal(
                "fetch",
                vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
                    if (String(input).includes("api.workos.com/sso/jwks/")) {
                        return Response.json({ keys: [jwk] });
                    }
                    return await nativeFetch(input, init);
                }),
            );
            daemon = await startHappyAgentDaemon({ happyHome, inference: await inference() });
            const clientFor = async (subject: string) =>
                new HappyAgentClient({
                    endpoint: daemon!.httpUrl!,
                    token: await signAccessToken(privateKey, subject),
                });
            let owner = await clientFor(OWNER_WORKOS_USER_ID);
            let member = await clientFor(MEMBER_WORKOS_USER_ID);
            const unfinished = {
                completed: false,
                steps: {
                    profile: { done: false },
                    project: { done: false },
                    providers: { done: true, signedIn: ["gym"] },
                },
            };
            await expect(owner.getOnboarding()).resolves.toEqual(unfinished);
            await expect(member.getOnboarding()).resolves.toEqual(unfinished);
            await expect(member.getHealth()).resolves.toMatchObject({ ready: true });
            await expect(member.completeOnboarding()).rejects.toMatchObject({
                status: 401,
                code: "unauthorized",
            });
            for (const read of [
                () => member.getConfig(),
                () => member.listProjects(),
                () => member.getDesktopBootstrap(),
            ]) {
                await expect(read()).rejects.toMatchObject({ status: 401 });
            }
            const ownerProfile = await owner.getProfile();
            await owner.updateProfile(
                { name: "Ada Lovelace", email: "ada@example.test" },
                { ifMatch: ownerProfile.profile.version },
            );
            await expect(owner.getOnboarding()).resolves.toMatchObject({
                completed: installationCompleted,
                steps: { profile: { done: true } },
            });
            await expect(owner.completeOnboarding()).resolves.toEqual({ completed: true });
            await expect(owner.completeOnboarding()).resolves.toEqual({ completed: true });
            await expect(readFile(markerPath, "utf8")).resolves.toBe("complete\n");

            // Completing the installation must not let another member skip their profile.
            await expect(member.getOnboarding()).resolves.toEqual(unfinished);
            const memberProfile = await member.getProfile();
            expect(memberProfile.profile.name).toBeNull();
            await member.updateProfile(
                { name: "Grace Hopper", email: "grace@example.test" },
                { ifMatch: memberProfile.profile.version },
            );
            // No second completion call, scope argument, or client-side team branch is needed.
            const finished = {
                ...unfinished,
                completed: true,
                steps: { ...unfinished.steps, profile: { done: true } },
            };
            await expect(member.getOnboarding()).resolves.toEqual(finished);
            await expect(member.getDesktopBootstrap()).resolves.toMatchObject({
                onboarding: finished,
                profile: { name: "Grace Hopper" },
            });
            await expect(member.getConfig()).resolves.toBeDefined();
            await expect(member.listProjects()).resolves.toBeDefined();

            await daemon.close();
            daemon = await startHappyAgentDaemon({ happyHome, inference: await inference() });
            owner = await clientFor(OWNER_WORKOS_USER_ID);
            member = await clientFor(MEMBER_WORKOS_USER_ID);
            const newcomer = await clientFor("user_newcomer789");
            const states = await Promise.all([
                owner.getOnboarding(),
                member.getOnboarding(),
                newcomer.getOnboarding(),
            ]);
            expect(states).toEqual([finished, finished, unfinished]);
            await expect(newcomer.completeOnboarding()).rejects.toMatchObject({ status: 401 });
            await expect(newcomer.getProfile()).resolves.toMatchObject({
                profile: { name: null },
            });
            await expect(member.getDesktopBootstrap()).resolves.toMatchObject({
                onboarding: finished,
            });
        },
        30_000,
    );

    it("starts without retaining a local API socket or bearer token", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-team-daemon-"));
        temporaryDirectories.push(root);
        const happyHome = join(root, ".happy");
        const configPath = join(
            root,
            process.platform === "darwin" ? "Happy/Config" : "happy/config",
            "happy.toml",
        );
        const tokenPath = join(happyHome, "agent", "token");
        const socketPath = join(happyHome, "agent", "server.sock");
        await Promise.all([
            mkdir(dirname(configPath), { recursive: true }),
            mkdir(dirname(tokenPath), { recursive: true }),
        ]);
        await Promise.all([
            writeFile(
                configPath,
                [
                    "[feature.team]",
                    "enabled = true",
                    'host = "127.0.0.1"',
                    "port = 0",
                    `workos_organization_id = "${ORGANIZATION_ID}"`,
                    `owner_workos_user_id = "${OWNER_WORKOS_USER_ID}"`,
                ].join("\n"),
            ),
            writeFile(tokenPath, `${"a".repeat(43)}\n`),
        ]);

        daemon = await startHappyAgentDaemon({
            happyHome,
            inference: await inference(),
        });

        await expect(readFile(tokenPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(socketPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        expect(daemon.httpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        const response = await fetch(`${daemon.httpUrl}/v0/health`);
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
            code: "unauthorized",
            error: "Unauthorized",
        });

        await daemon.close();
        daemon = undefined;
        const sqlite = new DatabaseSync(join(happyHome, "agent", "agent.sqlite"), {
            readOnly: true,
        });
        try {
            expect(
                sqlite
                    .prepare(
                        `SELECT name FROM sqlite_master
                         WHERE type = 'table'
                           AND name IN ('happy_agent_profile', 'happy_agent_team_users')
                         ORDER BY name`,
                    )
                    .all(),
            ).toEqual([{ name: "happy_agent_team_users" }]);
            expect(
                sqlite.prepare("SELECT COUNT(*) AS count FROM happy_agent_team_users").get(),
            ).toEqual({ count: 0 });
        } finally {
            sqlite.close();
        }
    });

    it("onboards an organization member through the existing profile API", async () => {
        const root = await mkdtemp(join(tmpdir(), "happy-agent-team-profile-"));
        temporaryDirectories.push(root);
        const happyHome = join(root, ".happy");
        const configPath = join(
            root,
            process.platform === "darwin" ? "Happy/Config" : "happy/config",
            "happy.toml",
        );
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(
            configPath,
            [
                "[feature.team]",
                "enabled = true",
                'host = "127.0.0.1"',
                "port = 0",
                `workos_organization_id = "${ORGANIZATION_ID}"`,
                `owner_workos_user_id = "${OWNER_WORKOS_USER_ID}"`,
            ].join("\n"),
        );

        const { privateKey, publicKey } = await generateKeyPair("RS256");
        const jwk = {
            ...(await exportJWK(publicKey)),
            alg: "RS256",
            kid: "team-daemon-test",
            use: "sig",
        };
        const nativeFetch = globalThis.fetch;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
                if (String(input).includes("api.workos.com/sso/jwks/")) {
                    return Response.json({ keys: [jwk] });
                }
                return await nativeFetch(input, init);
            }),
        );

        daemon = await startHappyAgentDaemon({ happyHome, inference: await inference() });
        const accessToken = await signAccessToken(privateKey);
        const authorization = `Bearer ${accessToken}`;
        const profileResponse = await fetch(`${daemon.httpUrl}/v0/profile`, {
            headers: { authorization },
        });
        expect(profileResponse.status).toBe(200);
        const empty = (await profileResponse.json()) as {
            readonly profile: { readonly version: string };
        };
        expect(empty).toMatchObject({
            profile: { email: null, name: null, photo: null, updatedAt: 0 },
        });

        const blocked = await fetch(`${daemon.httpUrl}/v0/config`, {
            headers: { authorization },
        });
        expect(blocked.status).toBe(401);

        const savedResponse = await fetch(`${daemon.httpUrl}/v0/profile`, {
            body: JSON.stringify({
                email: "ada@example.com",
                mutationId: "team-profile-1",
                name: "Ada Lovelace Byron",
            }),
            headers: {
                authorization,
                "content-type": "application/json",
                "if-match": empty.profile.version,
            },
            method: "PATCH",
        });
        expect(savedResponse.status).toBe(200);
        await expect(savedResponse.json()).resolves.toMatchObject({
            profile: {
                email: "ada@example.com",
                name: "Ada Lovelace Byron",
                photo: null,
            },
        });

        const admitted = await fetch(`${daemon.httpUrl}/v0/config`, {
            headers: { authorization },
        });
        expect(admitted.status).toBe(200);

        const memberAuthorization = `Bearer ${await signAccessToken(
            privateKey,
            MEMBER_WORKOS_USER_ID,
        )}`;
        const memberEmptyResponse = await fetch(`${daemon.httpUrl}/v0/profile`, {
            headers: { authorization: memberAuthorization },
        });
        const memberEmpty = (await memberEmptyResponse.json()) as {
            readonly profile: { readonly version: string };
        };
        const memberSaved = await fetch(`${daemon.httpUrl}/v0/profile`, {
            body: JSON.stringify({ mutationId: "team-profile-2", name: "Grace Hopper" }),
            headers: {
                authorization: memberAuthorization,
                "content-type": "application/json",
                "if-match": memberEmpty.profile.version,
            },
            method: "PATCH",
        });
        expect(memberSaved.status).toBe(200);

        const eventsResponse = await fetch(`${daemon.httpUrl}/v0/events`, {
            headers: { authorization: memberAuthorization },
        });
        expect(eventsResponse.status).toBe(200);
        const page = (await eventsResponse.json()) as {
            readonly events: readonly {
                readonly payload: Record<string, unknown>;
                readonly type: string;
            }[];
        };
        const profileUpdated = page.events.find((event) => event.type === "profile.updated");
        expect(profileUpdated).toBeDefined();
        expect(profileUpdated?.payload).toMatchObject({ mutationId: "team-profile-1" });
        expect(Object.keys(profileUpdated?.payload ?? {}).sort()).toEqual(["mutationId", "userId"]);

        await daemon.close();
        daemon = undefined;
        const sqlite = new DatabaseSync(join(happyHome, "agent", "agent.sqlite"), {
            readOnly: true,
        });
        try {
            expect(
                sqlite
                    .prepare(
                        `SELECT workos_user_id, first_name, last_name, email, is_owner
                         FROM happy_agent_team_users
                         WHERE workos_user_id = ?`,
                    )
                    .get(OWNER_WORKOS_USER_ID),
            ).toEqual({
                email: "ada@example.com",
                first_name: "Ada",
                is_owner: 1,
                last_name: "Lovelace Byron",
                workos_user_id: OWNER_WORKOS_USER_ID,
            });
            expect(
                sqlite
                    .prepare(
                        `SELECT first_name, last_name, is_owner
                         FROM happy_agent_team_users
                         WHERE workos_user_id = ?`,
                    )
                    .get(MEMBER_WORKOS_USER_ID),
            ).toEqual({ first_name: "Grace", is_owner: 0, last_name: "Hopper" });
        } finally {
            sqlite.close();
        }
    });
});

async function signAccessToken(
    privateKey: CryptoKey,
    subject = OWNER_WORKOS_USER_ID,
): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    return await new SignJWT({
        client_id: CLIENT_ID,
        org_id: ORGANIZATION_ID,
        sid: "session_team_daemon_test",
    })
        .setProtectedHeader({ alg: "RS256", kid: "team-daemon-test" })
        .setIssuer(`https://api.workos.com/user_management/${CLIENT_ID}`)
        .setSubject(subject)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);
}

async function inference(): Promise<{ models: AgentModel[]; providers: AgentProviders }> {
    const credential = await CodexApiKeyCredential.tryLoad({ apiKey: "test-key" });
    const providers = new AgentProviders();
    providers.add(
        "gym",
        new CodexProvider({
            credential: credential!,
            endpoint: "https://example.invalid/v1",
            userAgent: "happy-team-test/1.0",
        }),
        "codex",
    );
    return {
        models: [
            {
                defaultEffort: "medium",
                effortLevels: ["low", "medium", "high"],
                id: "gym/model",
                name: "Gym Model",
                providerId: "gym",
            },
        ],
        providers,
    };
}
