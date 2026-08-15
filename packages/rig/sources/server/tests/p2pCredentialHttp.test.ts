import { request, type Server } from "node:http";
import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestRootContext } from "../../testing/createTestRootContext.js";

import { P2pCredentialVersionConflictError } from "../../credentials/P2pCredentialStore.js";
import { createModelCatalog } from "../../model-catalog/createModelCatalog.js";
import { RigProfileStore } from "../../profiles/index.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import type { P2pEncryptedCredentialSnapshot } from "../../protocol/index.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

const LOCAL_ID = "alocalinstance00000000001";
const OWNER_ID = "aremoteinstance0000000001";
const OTHER_ID = "aotherinstance00000000001";
const OWNER_PROFILE_ID = "aownerprofile0000000000001";

describe("P2P inference credentials", () => {
    const close: (() => Promise<void>)[] = [];

    afterEach(async () => {
        await Promise.all(close.splice(0).map((stop) => stop()));
    });

    it("accepts an encrypted snapshot only from its authenticated owner and binds sessions to it", async () => {
        const ctx = createTestRootContext();
        const homeDirectory = await createTestSocketDirectory();
        close.push(() => rm(homeDirectory, { force: true, recursive: true }));
        const modelCatalog = createModelCatalog(createTestRootContext().named("model-catalog"), {
            providers: { codex: { apiKey: "local", enabled: true, type: "codex" } },
        });
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
            homeDirectory,
            localInstanceId: LOCAL_ID,
            modelCatalog,
            resolveModelCatalog: () => modelCatalog,
        });
        const profiles = new RigProfileStore({
            database: store,
            localInstanceId: LOCAL_ID,
            publish: () => undefined,
        });
        await profiles.replicate(
            ctx,
            {
                createdAt: 1,
                email: "steve@example.test",
                id: OWNER_PROFILE_ID,
                name: "Steve",
                parentInstanceId: OWNER_ID,
                updatedAt: 1,
                version: 1,
            },
            OWNER_ID,
        );
        const replace = vi.fn(async () => ({ changed: true, version: 1 }));
        const remoteCatalog = {
            ...modelCatalog,
            providers: modelCatalog.providers.map((provider) => ({
                ...provider,
                title: "codex — Steve's Rig",
            })),
        };
        const started = await startServer(
            await createProtocolHttpServer(createTestRootContext(), {
                canP2pPeerProvision: (peerId) => peerId === OWNER_ID,
                canP2pPeerUseRemoteWork: (peerId) => peerId === OWNER_ID || peerId === OTHER_ID,
                modelCatalog,
                profiles,
                replaceP2pCredentials: replace,
                resolveModelCatalog: () => remoteCatalog,
                store,
                token: "secret",
            }),
        );
        close.push(async () => {
            await started.close();
            await store.close(ctx);
        });
        const envelope: P2pEncryptedCredentialSnapshot = {
            algorithm: "nacl_box",
            ciphertext: "AAAA",
            nonce: "A".repeat(32),
            owner: { instanceId: OWNER_ID, publicKey: "A".repeat(43) },
        };

        expect(
            await send(
                started.socketPath,
                "PUT",
                "/inference-credentials",
                JSON.stringify(envelope),
            ),
        ).toMatchObject({ status: 403 });
        expect(
            await send(
                started.socketPath,
                "PUT",
                "/inference-credentials",
                JSON.stringify(envelope),
                OWNER_ID,
            ),
        ).toEqual({ body: { changed: true, version: 1 }, status: 200 });
        expect(replace).toHaveBeenCalledWith(expect.anything(), OWNER_ID, envelope);
        replace.mockImplementationOnce(() => {
            throw new P2pCredentialVersionConflictError(
                "The credential snapshot is older than saved state.",
                7,
            );
        });
        expect(
            await send(
                started.socketPath,
                "PUT",
                "/inference-credentials",
                JSON.stringify(envelope),
                OWNER_ID,
            ),
        ).toEqual({
            body: {
                error: "The credential snapshot is older than saved state.",
                version: 7,
            },
            status: 409,
        });
        expect(await send(started.socketPath, "GET", "/models", undefined, OWNER_ID)).toMatchObject(
            {
                body: {
                    catalog: {
                        providers: [{ title: "codex — Steve's Rig" }],
                    },
                },
                status: 200,
            },
        );

        const created = await send(
            started.socketPath,
            "POST",
            "/sessions",
            JSON.stringify({
                cwd: "/tmp/p2p-owner-session",
                identity: OWNER_PROFILE_ID,
            }),
            OWNER_ID,
        );
        expect(created).toMatchObject({
            body: {
                session: {
                    ownerInstanceId: OWNER_ID,
                    profileId: OWNER_PROFILE_ID,
                },
            },
            status: 201,
        });
        const sessionId = (created.body as { session: { id: string } }).session.id;
        expect(
            await send(started.socketPath, "GET", `/sessions/${sessionId}`, undefined, OTHER_ID),
        ).toMatchObject({
            body: { session: { id: sessionId, ownerInstanceId: OWNER_ID } },
            status: 200,
        });
    });

    it("shares broadcasts and timelines while keeping raw daemon event administration private", async () => {
        const ctx = createTestRootContext();
        const homeDirectory = await createTestSocketDirectory();
        close.push(() => rm(homeDirectory, { force: true, recursive: true }));
        const modelCatalog = createModelCatalog(createTestRootContext().named("model-catalog"), {
            providers: { codex: { apiKey: "local", enabled: true, type: "codex" } },
        });
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
            homeDirectory,
            localInstanceId: LOCAL_ID,
            modelCatalog,
            resolveModelCatalog: () => modelCatalog,
        });
        const profiles = new RigProfileStore({
            database: store,
            localInstanceId: LOCAL_ID,
            publish: () => undefined,
        });
        await profiles.replicate(
            ctx,
            {
                createdAt: 1,
                email: "steve@example.test",
                id: OWNER_PROFILE_ID,
                name: "Steve",
                parentInstanceId: OWNER_ID,
                updatedAt: 1,
                version: 1,
            },
            OWNER_ID,
        );
        const otherProfileId = "aotherprofile0000000000001";
        await profiles.replicate(
            ctx,
            {
                createdAt: 1,
                email: "other@example.test",
                id: otherProfileId,
                name: "Other",
                parentInstanceId: OTHER_ID,
                updatedAt: 1,
                version: 1,
            },
            OTHER_ID,
        );
        const otherSession = await store.create(
            ctx,
            { cwd: "/tmp/p2p-other-session" },
            { ownerInstanceId: OTHER_ID, profileId: otherProfileId },
        );
        const ownerSession = await store.create(
            ctx,
            { cwd: "/tmp/p2p-owner-session" },
            { ownerInstanceId: OWNER_ID, profileId: OWNER_PROFILE_ID },
        );
        const started = await startServer(
            await createProtocolHttpServer(createTestRootContext(), {
                canP2pPeerProvision: (peerId) => peerId === OWNER_ID,
                canP2pPeerUseRemoteWork: (peerId) => peerId === OWNER_ID,
                modelCatalog,
                profiles,
                store,
                token: "secret",
            }),
        );
        close.push(async () => {
            await started.close();
            await store.close(ctx);
        });

        expect(
            await send(
                started.socketPath,
                "POST",
                "/messages",
                JSON.stringify({
                    all: true,
                    identity: OWNER_PROFILE_ID,
                    text: "Every shared session.",
                }),
                OWNER_ID,
            ),
        ).toMatchObject({
            body: {
                submissions: expect.arrayContaining([
                    expect.objectContaining({ sessionId: ownerSession.id }),
                    expect.objectContaining({ sessionId: otherSession.id }),
                ]),
            },
            status: 202,
        });

        expect(
            await send(
                started.socketPath,
                "POST",
                "/messages",
                JSON.stringify({
                    identity: OWNER_PROFILE_ID,
                    sessionIds: [otherSession.id],
                    text: "Continue the other profile's session.",
                }),
                OWNER_ID,
            ),
        ).toMatchObject({
            body: { submissions: [{ sessionId: otherSession.id }] },
            status: 202,
        });

        expect(
            await send(
                started.socketPath,
                "POST",
                "/timeline",
                JSON.stringify({ scope: { kind: "global" } }),
                OWNER_ID,
            ),
        ).toMatchObject({
            body: {
                agents: expect.arrayContaining([
                    expect.objectContaining({ sessionId: ownerSession.id }),
                    expect.objectContaining({ sessionId: otherSession.id }),
                ]),
            },
            status: 200,
        });

        for (const request of [
            { method: "GET", path: "/events" },
            { method: "GET", path: "/events/stream" },
            { method: "POST", path: "/events/trim" },
        ]) {
            expect(
                await send(
                    started.socketPath,
                    request.method,
                    request.path,
                    request.method === "POST" ? JSON.stringify({ through: "ignored" }) : undefined,
                    OWNER_ID,
                ),
            ).toMatchObject({ status: 403 });
        }
    });
});

async function send(
    socketPath: string,
    method: string,
    path: string,
    body?: string,
    peerId?: string,
): Promise<{ body: unknown; status: number }> {
    return await new Promise((resolve, reject) => {
        const outgoing = request(
            {
                headers: {
                    authorization: "Bearer secret",
                    ...(body === undefined
                        ? {}
                        : {
                              "content-length": Buffer.byteLength(body),
                              "content-type": "application/json",
                          }),
                    ...(peerId === undefined ? {} : { "x-rig-p2p-peer": peerId }),
                },
                method,
                path,
                socketPath,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk) =>
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
                );
                response.once("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    resolve({
                        body: text.length === 0 ? undefined : JSON.parse(text),
                        status: response.statusCode ?? 0,
                    });
                });
            },
        );
        outgoing.once("error", reject);
        outgoing.end(body);
    });
}

async function startServer(server: Server): Promise<{
    close: () => Promise<void>;
    socketPath: string;
}> {
    const directory = await createTestSocketDirectory();
    const socketPath = `${directory}/server.sock`;
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    return {
        close: async () => {
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error === undefined ? resolve() : reject(error))),
            );
            await rm(directory, { force: true, recursive: true });
        },
        socketPath,
    };
}
