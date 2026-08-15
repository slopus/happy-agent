import { request as httpRequest } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createTestRootContext } from "../../testing/createTestRootContext.js";

import { createProtocolHttpServer } from "../createProtocolHttpServer.js";
import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { createTestFixtureDirectory } from "../../testing/createTestFixtureDirectory.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Folders over HTTP", () => {
    it("creates a folder, nests one inside it, and lists the tree parents first", async () => {
        const fixture = await startServer();

        const root = await fixture.send("POST", "/folders", {
            description: "Everything about the launch film",
            icon: "🎬",
            name: "Launch film",
            rules: "Keep every cut under two minutes.",
        });
        expect(root.status).toBe(201);
        expect(root.body.folder).toMatchObject({
            description: "Everything about the launch film",
            icon: "🎬",
            name: "Launch film",
            rules: "Keep every cut under two minutes.",
        });
        expect(root.body.folder.parentId).toBeUndefined();

        const child = await fixture.send("POST", "/folders", {
            name: "B-roll",
            parentId: root.body.folder.id,
        });
        expect(child.status).toBe(201);
        expect(child.body.folder.parentId).toBe(root.body.folder.id);

        const listed = await fixture.send("GET", "/folders");
        expect(listed.status).toBe(200);
        expect(listed.body.folders.map((folder: { name: string }) => folder.name)).toEqual([
            "Launch film",
            "B-roll",
        ]);
    });

    it("gives each folder its own flat storage directory", async () => {
        const fixture = await startServer();

        const first = await fixture.send("POST", "/folders", { name: "First" });
        const second = await fixture.send("POST", "/folders", {
            name: "Second",
            parentId: first.body.folder.id,
        });

        expect(second.body.folder.path).not.toContain(first.body.folder.id);
        expect(first.body.folder.path.endsWith(first.body.folder.id)).toBe(true);
        expect(second.body.folder.path.endsWith(second.body.folder.id)).toBe(true);
    });

    it("moves a folder without moving its files", async () => {
        const fixture = await startServer();
        const home = await fixture.send("POST", "/folders", { name: "Home" });
        const away = await fixture.send("POST", "/folders", { name: "Away" });
        const moving = await fixture.send("POST", "/folders", {
            name: "Moving",
            parentId: home.body.folder.id,
        });

        const moved = await fixture.send(
            `POST`,
            `/folders/${moving.body.folder.id}/move`,
            {
                afterId: null,
                parentId: away.body.folder.id,
            },
            { "if-match": String(moving.body.folder.version) },
        );

        expect(moved.status).toBe(200);
        expect(moved.body.folder.parentId).toBe(away.body.folder.id);
        expect(moved.body.folder.path).toBe(moving.body.folder.path);
    });

    it("refuses to move a folder inside its own subtree", async () => {
        const fixture = await startServer();
        const parent = await fixture.send("POST", "/folders", { name: "Parent" });
        const child = await fixture.send("POST", "/folders", {
            name: "Child",
            parentId: parent.body.folder.id,
        });

        const refused = await fixture.send(
            "POST",
            `/folders/${parent.body.folder.id}/move`,
            {
                afterId: null,
                parentId: child.body.folder.id,
            },
            { "if-match": String(parent.body.folder.version) },
        );

        expect(refused.status).toBe(400);
        expect(refused.body.error.code).toBe("cycle");
    });

    it("changes a folder's own fields and clears the ones set to null", async () => {
        const fixture = await startServer();
        const created = await fixture.send("POST", "/folders", {
            icon: "📼",
            name: "Rough cuts",
            rules: "Ship nothing from here.",
        });

        const updated = await fixture.send(
            "PATCH",
            `/folders/${created.body.folder.id}`,
            {
                icon: null,
                name: "Final cuts",
            },
            { "if-match": String(created.body.folder.version) },
        );

        expect(updated.status).toBe(200);
        expect(updated.body.folder.name).toBe("Final cuts");
        expect(updated.body.folder.icon).toBeUndefined();
        expect(updated.body.folder.rules).toBe("Ship nothing from here.");
    });

    it("answers with folder_not_found for a folder that is gone", async () => {
        const fixture = await startServer();

        const missing = await fixture.send("GET", "/folders/nowhere");

        expect(missing.status).toBe(404);
        expect(missing.body.error.code).toBe("folder_not_found");
    });

    it("accepts quoted entity versions and deduplicates a lost response after later edits", async () => {
        const fixture = await startServer();
        const created = await fixture.send("POST", "/folders", { name: "Draft" });
        const folderId = created.body.folder.id as string;

        const first = await fixture.send(
            "PATCH",
            `/folders/${folderId}`,
            { mutationId: "rename-first", name: "First" },
            { "if-match": `"${created.body.folder.version}"`, "x-rig-mutation-id": "rename-first" },
        );
        expect(first.status).toBe(200);

        const second = await fixture.send(
            "PATCH",
            `/folders/${folderId}`,
            { mutationId: "rename-second", name: "Second" },
            { "if-match": `"${first.body.folder.version}"`, "x-rig-mutation-id": "rename-second" },
        );
        expect(second.status).toBe(200);

        const retried = await fixture.send(
            "PATCH",
            `/folders/${folderId}`,
            { mutationId: "rename-first", name: "First" },
            { "if-match": `"${created.body.folder.version}"`, "x-rig-mutation-id": "rename-first" },
        );
        expect(retried.status).toBe(200);
        expect(retried.body.folder.name).toBe("Second");
        expect(retried.body.folder.version).toBe(second.body.folder.version);
    });

    it("files a chat into a folder and back out to Unsorted", async () => {
        const fixture = await startServer();
        const folder = await fixture.send("POST", "/folders", { name: "Trip planning" });
        const chat = await fixture.store.create(createTestRootContext(), {
            cwd: "/tmp/rig-folders",
        });

        const filed = await fixture.send("PUT", `/sessions/${chat.id}/scope`, {
            afterId: null,
            mutationId: "file-chat",
            scope: { folderId: folder.body.folder.id, kind: "folder" },
        });
        expect(filed.status).toBe(200);
        expect(filed.body.session.folderId).toBe(folder.body.folder.id);

        const unfiled = await fixture.send("PUT", `/sessions/${chat.id}/scope`, {
            afterId: null,
            mutationId: "unfile-chat",
            scope: { kind: "unsorted" },
        });
        expect(unfiled.status).toBe(200);
        expect(unfiled.body.session.folderId).toBeUndefined();
    });

    it("moves a chat through the canonical scope route with scoped ordering and retry identity", async () => {
        const fixture = await startServer();
        const folder = await fixture.send("POST", "/folders", { name: "Ordered" });
        const first = await fixture.store.create(createTestRootContext(), {
            cwd: "/tmp/rig-folders",
        });
        const second = await fixture.store.create(createTestRootContext(), {
            cwd: "/tmp/rig-folders",
        });
        const mutationId = "move-first";
        const staleVersion = first.events.lastEventId();

        const moved = await fixture.send(
            "PUT",
            `/sessions/${first.id}/scope`,
            {
                afterId: null,
                mutationId,
                scope: { folderId: folder.body.folder.id, kind: "folder" },
            },
            {
                ...(staleVersion === undefined ? {} : { "if-match": `"${staleVersion}"` }),
                "x-rig-mutation-id": mutationId,
            },
        );
        expect(moved.status).toBe(200);
        expect(moved.body.session.scope).toEqual({
            folderId: folder.body.folder.id,
            kind: "folder",
        });

        const retried = await fixture.send(
            "PUT",
            `/sessions/${first.id}/scope`,
            {
                afterId: null,
                mutationId,
                scope: { folderId: folder.body.folder.id, kind: "folder" },
            },
            {
                ...(staleVersion === undefined ? {} : { "if-match": `"${staleVersion}"` }),
                "x-rig-mutation-id": mutationId,
            },
        );
        expect(retried.status).toBe(200);

        const movedSecond = await fixture.send("PUT", `/sessions/${second.id}/scope`, {
            afterId: first.id,
            mutationId: "move-second",
            scope: { folderId: folder.body.folder.id, kind: "folder" },
        });
        expect(movedSecond.status, JSON.stringify(movedSecond.body)).toBe(200);
        const laterMove = await fixture.send(
            "PUT",
            `/sessions/${first.id}/scope`,
            {
                afterId: null,
                mutationId: "move-later",
                scope: { kind: "unsorted" },
            },
            {
                "if-match": `"${retried.body.session.lastEventId}"`,
                "x-rig-mutation-id": "move-later",
            },
        );
        expect(laterMove.status).toBe(200);
        const lostResponseRetry = await fixture.send(
            "PUT",
            `/sessions/${first.id}/scope`,
            {
                afterId: null,
                mutationId,
                scope: { folderId: folder.body.folder.id, kind: "folder" },
            },
            {
                ...(staleVersion === undefined ? {} : { "if-match": `"${staleVersion}"` }),
                "x-rig-mutation-id": mutationId,
            },
        );
        expect(lostResponseRetry.status).toBe(200);
        expect(lostResponseRetry.body.session.scope).toEqual({ kind: "unsorted" });

        const crossScope = await fixture.send("PUT", `/sessions/${first.id}/scope`, {
            afterId: second.id,
            scope: { kind: "unsorted" },
        });
        expect(crossScope.status).toBe(400);
        expect(first.snapshot().scope.kind).toBe("unsorted");
    });

    it("archives a folder together with everything under it", async () => {
        const fixture = await startServer();
        const parent = await fixture.send("POST", "/folders", { name: "Season one" });
        await fixture.send("POST", "/folders", {
            name: "Episode one",
            parentId: parent.body.folder.id,
        });

        const archived = await fixture.send(
            "POST",
            `/folders/${parent.body.folder.id}/archive`,
            undefined,
            { "if-match": String(parent.body.folder.version) },
        );

        expect(archived.status).toBe(200);
        expect(archived.body.folder.archivedAt).toEqual(expect.any(Number));
        const remaining = await fixture.send("GET", "/folders");
        expect(
            remaining.body.folders.filter(
                (folder: { archivedAt?: number }) => folder.archivedAt === undefined,
            ),
        ).toEqual([]);
    });

    it("prevents work and individual restoration after a chat's folder is archived", async () => {
        const fixture = await startServer();
        const folder = await fixture.send("POST", "/folders", { name: "Finished" });
        const chat = await fixture.store.create(createTestRootContext(), {
            cwd: "/ignored",
            scope: { folderId: folder.body.folder.id, kind: "folder" },
        });

        const archived = await fixture.send(
            "POST",
            `/folders/${folder.body.folder.id}/archive`,
            undefined,
            { "if-match": String(folder.body.folder.version) },
        );
        expect(archived.status).toBe(200);
        await expect(
            chat.runShellCommand(createTestRootContext(), {
                command: "echo archived",
                commandId: "archived-command",
            }),
        ).rejects.toThrow("archived");

        const restored = await fixture.send("POST", `/sessions/${chat.id}/unarchive`);
        expect(restored.status).toBe(409);
        expect(chat.snapshot()).toMatchObject({ archived: true, status: "archived" });
    });
});

async function startServer(): Promise<{
    send: (
        method: string,
        path: string,
        body?: unknown,
        headers?: Record<string, string>,
    ) => Promise<{ body: any; status: number }>;
    store: InMemorySessionStore;
}> {
    const root = await createTestFixtureDirectory();
    const socketDirectory = await createTestSocketDirectory();
    const socketPath = join(socketDirectory, "server.sock");
    const store = await InMemorySessionStore.open(createTestRootContext(), {
        homeDirectory: root,
        workspacesDirectory: join(root, "workspaces"),
    });
    const server: Server = await createProtocolHttpServer(createTestRootContext(), {
        store,
        token: "t",
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    cleanups.push(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.all([
            rm(root, { force: true, recursive: true }),
            rm(socketDirectory, { force: true, recursive: true }),
        ]);
    });

    const send = async (
        method: string,
        path: string,
        body?: unknown,
        headers: Record<string, string> = {},
    ) =>
        await new Promise<{ body: any; status: number }>((resolve, reject) => {
            const payload = body === undefined ? undefined : JSON.stringify(body);
            const call = httpRequest(
                {
                    headers: {
                        authorization: "Bearer t",
                        ...headers,
                        ...(payload === undefined
                            ? {}
                            : {
                                  "content-length": Buffer.byteLength(payload),
                                  "content-type": "application/json",
                              }),
                    },
                    method,
                    path,
                    socketPath,
                },
                (response) => {
                    let raw = "";
                    response.on("data", (chunk) => (raw += String(chunk)));
                    response.on("end", () =>
                        resolve({
                            body: raw.length === 0 ? undefined : JSON.parse(raw),
                            status: response.statusCode ?? 0,
                        }),
                    );
                },
            );
            call.on("error", reject);
            if (payload !== undefined) call.write(payload);
            call.end();
        });

    return { send, store };
}
