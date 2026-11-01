import { join } from "node:path";
import { ensureAgentDatabaseConnection, type AgentSystemRef } from "@slopus/happy-agent-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactsModule } from "../../sources/artifacts/index.js";
import type { BotsModule } from "../../sources/bots/index.js";
import type { ComputeModule } from "../../sources/compute/index.js";
import type { ConfigModule } from "../../sources/config/index.js";
import type { RunnersModule } from "../../sources/runners/index.js";
import type { TasksModule } from "../../sources/tasks/index.js";
import type { TeamModule } from "../../sources/team/index.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { SurfacesModule } from "../../sources/surfaces/index.js";
import { SurfacesPersistence } from "../../sources/surfaces/persistence/SurfacesPersistence.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const close: (() => void)[] = [];
afterEach(() => {
    close
        .splice(0)
        .reverse()
        .forEach((dispose) => dispose());
});

async function fixture(runner: Partial<RunnersModule>) {
    const durable = new DurableFunctionsModule();
    let releaseFolder!: () => void;
    const folderReady = new Promise<void>((resolve) => (releaseFolder = resolve));
    const mkdir = vi.fn(async () => await folderReady);
    const created = vi.fn(async (..._args: unknown[]) => ({}));
    const runners = {
        machineHome: () => ({ home: "/home/person", platform: "linux" }),
        environment: (_runnerId: string | undefined, workingDirectory: string) => ({
            osVersion: "Linux",
            platform: "linux",
            shell: "",
            workingDirectory,
        }),
        machine: async () => ({ fs: { mkdir } }),
        ...runner,
    } as unknown as RunnersModule;
    const config = {
        surfacePathOn: (home: string, _platform: string, id: string) =>
            join(home, "happy", "Surfaces", id),
    } as unknown as ConfigModule;
    const surfaces = new SurfacesModule(
        durable,
        { enabled: false } as unknown as TeamModule,
        { forAgent: async () => undefined } as unknown as BotsModule,
        { get: async () => undefined } as unknown as TasksModule,
        { get: async () => undefined } as unknown as ArtifactsModule,
        {} as ComputeModule,
        config,
        runners,
    );
    const db = moduleDatabase([...durable.migrations, ...surfaces.migrations], "surface-chats");
    ensureAgentDatabaseConnection(db.database);
    close.push(() => {
        durable.stop();
        db.close();
    });
    await db.ready;
    const agents = { create: created } as unknown as AgentSystemRef;
    const durableHooks = durable.beforeStart(db.context);
    surfaces.beforeStart(db.context, agents);
    await durableHooks.afterStart?.(db.context, agents);
    return {
        surfaces,
        ctx: db.context,
        kv: new SurfacesPersistence(db.database).kv(),
        mkdir,
        created,
        releaseFolder,
    };
}

describe("Surface chat preparation", () => {
    it("reserves identities before the folder exists and names the agent only after it does", async () => {
        const f = await fixture({});
        const surface = await f.surfaces.create(f.ctx, { type: "todo", name: "Inbox" }, null);
        await f.surfaces.requestChat(f.ctx, surface.id, "first");
        const reserved = await f.kv.read(f.ctx, `chat.${surface.id}`);
        expect(reserved).toMatchObject({
            surfaceId: surface.id,
            path: join("/home/person", "happy", "Surfaces", surface.id),
            mutationId: "first",
        });
        await vi.waitFor(() => expect(f.mkdir).toHaveBeenCalled());

        // A retry while the folder is pending resumes the same reservation and exposes nothing.
        await f.surfaces.requestChat(f.ctx, surface.id, "second");
        expect(await f.kv.read(f.ctx, `chat.${surface.id}`)).toEqual(reserved);
        expect((await f.surfaces.list(f.ctx))[0]!.chatAgentId).toBeNull();
        const { agentId, workspaceId } = reserved as { agentId: string; workspaceId: string };
        expect(await f.surfaces.chatForAgent(f.ctx, agentId)).toBeUndefined();
        expect(await f.surfaces.chatForWorkspace(f.ctx, workspaceId)).toBeUndefined();
        expect(f.created).not.toHaveBeenCalled();

        const waiting = f.surfaces.awaitChat(f.ctx, surface.id);
        f.releaseFolder();
        const ready = await waiting;
        expect(ready.chat).toEqual(reserved);
        expect(ready.surface.chatAgentId).toBe(agentId);
        expect(ready.surface.version > surface.version).toBe(true);
        expect(f.created).toHaveBeenCalledTimes(1);
        expect(f.created.mock.calls[0]![2]).toEqual({ id: agentId, parent: null });
        expect(await f.surfaces.chatForAgent(f.ctx, agentId)).toEqual(reserved);
        expect(await f.surfaces.chatForWorkspace(f.ctx, workspaceId)).toEqual(reserved);

        await f.surfaces.requestChat(f.ctx, surface.id);
        expect((await f.surfaces.list(f.ctx))[0]).toEqual(ready.surface);
        expect(f.created).toHaveBeenCalledTimes(1);
    });

    it("reports a runner that never connected as not ready and reserves nothing", async () => {
        const f = await fixture({
            defaultRunnerId: "studio",
            home: () => undefined,
            displayName: () => "Studio",
        } as unknown as Partial<RunnersModule>);
        const surface = await f.surfaces.create(f.ctx, { type: "document", name: "Plan" }, null);
        await expect(f.surfaces.requestChat(f.ctx, surface.id)).rejects.toMatchObject({
            code: "not_initialized",
        });
        expect(await f.kv.read(f.ctx, `chat.${surface.id}`)).toBeUndefined();
        expect(f.mkdir).not.toHaveBeenCalled();
        expect((await f.surfaces.list(f.ctx))[0]).toEqual(surface);
    });

    it("refuses stored types without chats, and withdrawn separators, without reserving anything", async () => {
        const f = await fixture({});
        const stored = (id: string, type: string) => ({
            id,
            type,
            name: "Stored",
            creatorUserId: null,
            chatAgentId: null,
            image: null,
            members: [{ userId: null, joinedAt: 1, orderKey: "1" }],
            updatedAt: 1,
            version: "01890a5d-ac96-774b-bcce-b302099a8057",
        });
        const whiteboard = "whiteboardsurface0000001";
        const separator = "separatorsurface00000001";
        await f.kv.write(f.ctx, `surface.${whiteboard}`, stored(whiteboard, "whiteboard"));
        await f.kv.write(f.ctx, `surface.${separator}`, stored(separator, "separator"));
        await expect(f.surfaces.requestChat(f.ctx, whiteboard)).rejects.toMatchObject({
            code: "conflict",
        });
        await expect(f.surfaces.requestChat(f.ctx, separator)).rejects.toMatchObject({
            code: "not_found",
        });
        expect(await f.kv.read(f.ctx, `chat.${whiteboard}`)).toBeUndefined();
        expect(await f.kv.read(f.ctx, `chat.${separator}`)).toBeUndefined();
        expect(f.mkdir).not.toHaveBeenCalled();
    });
});
