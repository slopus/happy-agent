import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ensureAgentDatabaseConnection } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { WorkOS } from "@workos-inc/node";
import { describe, expect, test } from "vitest";

import { CloudModule } from "../../sources/cloud/CloudModule.js";
import { cloudSession, createCloudDatabase } from "../../sources/cloud/CloudDatabase.js";
import { type CloudAuthentication } from "../../sources/cloud/CloudWorkOS.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const WORKOS_CLIENT_ID = "client_01KZD3XE4EW1AF1P6WTFHBPR4J";
const REQUEST_TIMEOUT_MILLISECONDS = 20_000;
const LIVE_TEST_TIMEOUT_MILLISECONDS = 180_000;
const DEFAULT_CREDENTIALS_FILE = fileURLToPath(
    new URL("../../../../.context/workos-staging.json", import.meta.url),
);
const CREDENTIALS_PATH_VARIABLE = "HAPPY_AGENT_WORKOS_STAGING_CREDENTIALS_FILE";

const stagingCredentialsSchema = Type.Object(
    { workosApiKey: Type.String({ minLength: 1, maxLength: 4_096 }) },
    { additionalProperties: false },
);
type StagingCredentials = Static<typeof stagingCredentialsSchema>;

interface LiveCloudInstance {
    readonly cloud: CloudModule;
    readonly database: ModuleDatabase;
    stop(): Promise<void>;
}

function stagingCredentials(): StagingCredentials | undefined {
    const explicitPath = process.env[CREDENTIALS_PATH_VARIABLE];
    const path = explicitPath ?? DEFAULT_CREDENTIALS_FILE;
    if (!existsSync(path)) {
        if (explicitPath !== undefined) {
            throw new Error(`${CREDENTIALS_PATH_VARIABLE} does not name a readable file.`);
        }
        return undefined;
    }
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
        throw new Error("The WorkOS staging credential file is not valid JSON.");
    }
    if (!Value.Check(stagingCredentialsSchema, value)) {
        throw new Error("The WorkOS staging credential file must contain only workosApiKey.");
    }
    return structuredClone(value) as StagingCredentials;
}

const credentials = stagingCredentials();

/** Seed a real WorkOS session; browser PKCE completion remains covered by deterministic tests. */
async function openCloudInstance(authentication: CloudAuthentication): Promise<LiveCloudInstance> {
    const durableFunctions = new DurableFunctionsModule();
    const cloud = new CloudModule(durableFunctions);
    const database = moduleDatabase(
        [...cloud.migrations, ...durableFunctions.migrations],
        "cloud-staging-auth-organizations",
    );
    let stopped = false;
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        try {
            await cloud.stop();
        } finally {
            durableFunctions.stop();
            database.close();
        }
    };
    try {
        ensureAgentDatabaseConnection(database.database);
        await database.ready;
        const ctx = database.context;
        await createCloudDatabase().replace(ctx, {
            error: null,
            pending: false,
            session: cloudSession("staging", authentication.refreshToken, authentication.user),
        });
        const durableHooks = await resolveModuleHooks(ctx, durableFunctions);
        const cloudHooks = await resolveModuleHooks(ctx, cloud);
        await durableHooks.afterStart?.(ctx, {} as never);
        await cloudHooks.afterStart?.(ctx, {} as never);
        return { cloud, database, stop };
    } catch (error: unknown) {
        await stop();
        throw error;
    }
}

describe.runIf(credentials !== undefined)("Happy Agent Cloud staging lifecycle", () => {
    test(
        "refreshes a verified WorkOS session, manages its organization, and signs out locally",
        async () => {
            const workos = new WorkOS({
                apiKey: credentials!.workosApiKey,
                clientId: WORKOS_CLIENT_ID,
                maxRetries: 0,
                timeout: REQUEST_TIMEOUT_MILLISECONDS,
            });
            const email = `ha-${crypto.randomUUID()}@cloud-e2e.test`;
            const password = `Happy-Agent-${crypto.randomUUID()}-Aa1!`;
            const user = await workos.userManagement.createUser({
                email,
                emailVerified: true,
                firstName: "Happy Agent staging",
                password,
            });
            let instance: LiveCloudInstance | undefined;
            let organizationId: string | undefined;
            try {
                const authenticated = await workos.userManagement.authenticateWithPassword({
                    clientId: WORKOS_CLIENT_ID,
                    email,
                    password,
                });
                instance = await openCloudInstance({
                    accessToken: authenticated.accessToken,
                    refreshToken: authenticated.refreshToken,
                    user: {
                        email: authenticated.user.email,
                        firstName: authenticated.user.firstName ?? null,
                        id: authenticated.user.id,
                        lastName: authenticated.user.lastName ?? null,
                    },
                });
                const { cloud, database } = instance;
                const ctx = database.context;
                const minted = await cloud.mint(ctx);
                expect(minted.accessToken.length > 0).toBe(true);
                expect(minted.cloud).toMatchObject({
                    environment: "staging",
                    status: "connected",
                    user: { email, id: user.id },
                });
                await expect(cloud.getWorkOSState(ctx)).resolves.toEqual({
                    workosClientId: WORKOS_CLIENT_ID,
                    workosUserId: user.id,
                });

                const organization = await cloud.createOrganization(
                    ctx,
                    `Happy Agent staging ${crypto.randomUUID()}`,
                );
                organizationId = organization.id;
                expect((await cloud.listOrganizations(ctx)).organizations).toContainEqual(
                    organization,
                );
                const endpoint = "https://team.example/agent";
                await expect(cloud.setTeamEndpoint(ctx, organization.id, endpoint)).resolves.toBe(
                    endpoint,
                );
                expect(await cloud.listTeams(ctx)).toContainEqual({ ...organization, endpoint });
                const organizationToken = await cloud.mintForOrganization(ctx, organization.id);
                expect(organizationToken.length > 0).toBe(true);
                expect(cloud.status(ctx).user?.id).toBe(user.id);

                await cloud.deleteOrganization(ctx, organization.id);
                organizationId = undefined;
                expect((await cloud.listOrganizations(ctx)).organizations).not.toContainEqual(
                    organization,
                );
                const disconnected = await cloud.disconnect(ctx);
                expect(disconnected).toMatchObject({
                    authorization: null,
                    environment: null,
                    error: null,
                    status: "disconnected",
                    user: null,
                });
                expect((await createCloudDatabase().read(ctx))?.session).toBeNull();
                await expect(cloud.mint(ctx)).rejects.toMatchObject({
                    code: "cloud_not_authenticated",
                });
                expect(JSON.stringify(cloud.status(ctx)).includes(minted.accessToken)).toBe(false);
                expect(JSON.stringify(cloud.status(ctx)).includes(authenticated.refreshToken)).toBe(
                    false,
                );
            } finally {
                try {
                    await instance?.stop();
                } finally {
                    try {
                        if (organizationId !== undefined) {
                            await workos.organizations.deleteOrganization(organizationId);
                        }
                    } finally {
                        await workos.userManagement.deleteUser(user.id);
                    }
                }
            }
        },
        LIVE_TEST_TIMEOUT_MILLISECONDS,
    );
});
