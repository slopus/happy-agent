import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AgentStorage,
    AgentSystemLocal,
    openAgentSQLiteDatabase,
    withAgentDatabase,
    type AgentRecord,
} from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import {
    happySyncMigrations,
    createHappySyncDatabase,
} from "../../sources/happy/HappySyncDatabase.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";
import { providersOf } from "../support/fixtures.js";
import { readHappyContextWindow } from "../../sources/happy/readHappyContextWindow.js";

export const contextRequest = {
    provider: "rig",
    directory: "/sanitized/original/project",
    sessionId: "remote-session",
};

export async function contextWindowFixture(provider = new ScriptedProvider([])) {
    const directory = await mkdtemp(join(tmpdir(), "happy-context-test-"));
    const connection = await openAgentSQLiteDatabase(join(directory, "native.db"));
    const ctx = withAgentDatabase(createRootContext().named("context-test"), connection.database);
    const storage = new AgentStorage({
        database: connection.database,
        acquireLock: async () => ({ release: async () => {} }),
    });
    await storage.migrate(ctx, []);
    for (const [, migrate] of happySyncMigrations) await migrate(ctx, connection.database);
    const system = await AgentSystemLocal.create(ctx, storage, {
        provider: "scripted",
        providers: providersOf(provider),
        models: [],
    });
    await system.create(
        ctx,
        {
            environment: {
                workingDirectory: contextRequest.directory,
                platform: "linux",
                osVersion: "fixture",
                shell: "/bin/sh",
            },
        },
        { id: "nativeagent" },
    );
    const sync = createHappySyncDatabase("owner-a");
    await sync.ensureSession(
        ctx,
        {
            agentId: "nativeagent",
            sessionId: "nativeagent",
            credentialFingerprint: "account-a",
            encryptionKeyBase64: "a2V5",
            encryptionVariant: "legacy",
        },
        1,
    );
    await sync.setRemoteSession(ctx, "nativeagent", "remote-session", 2);
    const records = JSON.parse(
        await readFile(new URL("./fixtures/context-records.json", import.meta.url), "utf8"),
    ) as AgentRecord[];
    const persistence = storage.persistence("nativeagent");
    for (const record of records) await persistence.append(ctx, record);
    const read = (
        params: unknown = contextRequest,
        ownerId = "owner-a",
        fingerprint = "account-a",
        readCtx = ctx,
    ) =>
        readHappyContextWindow({
            ctx: readCtx,
            ownerId,
            fingerprint,
            params,
            config: (readCtx, id) => system.config(readCtx, id),
        });
    return {
        ctx,
        storage,
        system,
        persistence,
        records,
        sync,
        read,
        connection,
        close: async () => {
            await system.close(ctx);
            await connection.close();
            await rm(directory, { recursive: true, force: true });
        },
    };
}
