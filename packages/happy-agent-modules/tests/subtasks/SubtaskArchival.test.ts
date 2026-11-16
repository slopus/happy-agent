import type { AgentConfig } from "@slopus/happy-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { SubtaskInputError, SubtasksModule } from "../../sources/subtasks/index.js";

type Listener = (ctx: Context, event: unknown) => Promise<void>;

/**
 * A workspace-bound subtask, a shared-filesystem subtask beside it, and their workspaces held in
 * memory. Agent metadata updates run the module's transactional hook, and workspace archival
 * publishes `begin_archive`, the way the real modules call each other inside one transaction.
 */
function fixture() {
    const ctx = createRootContext();
    const configs = new Map<string, AgentConfig>([
        [
            "resident",
            {
                metadata: { subtask: true, version: 1, subtaskWorkspaceId: "taskspace" },
            } as AgentConfig,
        ],
        ["shared", { metadata: { subtask: true, version: 1 } } as AgentConfig],
    ]);
    const workspaces = new Map<string, { id: string; status: string; subtaskAgentId?: string }>([
        ["taskspace", { id: "taskspace", status: "ready", subtaskAgentId: "resident" }],
        ["sharedspace", { id: "sharedspace", status: "ready" }],
        ["other", { id: "other", status: "ready", subtaskAgentId: "resident" }],
    ]);
    const listeners: Listener[] = [];
    const archivedWorkspaces: string[] = [];
    const metadataUpdates: string[] = [];
    let hooks!: ReturnType<SubtasksModule["beforeStart"]>;

    const workspacesModule = {
        onEventTransactional: (listener: Listener) => listeners.push(listener),
        get: async (_ctx: Context, id: string) => workspaces.get(id),
        archive: async (txCtx: Context, id: string) => {
            const workspace = workspaces.get(id)!;
            if (workspace.status === "archiving") return workspace;
            archivedWorkspaces.push(id);
            const archiving = { ...workspace, status: "archiving" };
            workspaces.set(id, archiving);
            for (const listener of listeners) {
                await listener(txCtx, {
                    type: "workspace_updated",
                    change: "begin_archive",
                    workspace: archiving,
                    previousWorkspace: workspace,
                });
            }
            return archiving;
        },
    };
    const agents = {
        config: async (_ctx: Context, id: string) => configs.get(id),
        updateMetadata: async (txCtx: Context, id: string, update: Record<string, unknown>) => {
            metadataUpdates.push(id);
            const config = configs.get(id)!;
            const previousMetadata = config.metadata ?? {};
            const metadata = { ...previousMetadata, ...update };
            configs.set(id, { ...config, metadata } as AgentConfig);
            await hooks.metadataChangedTransact!(
                txCtx,
                { agent: { id, metadata } } as never,
                { agentId: id, previousMetadata, update, metadata } as never,
            );
        },
    };
    const durableFunctions = { register: vi.fn(), invoke: vi.fn(), cancel: vi.fn() };
    const abort = { abort: vi.fn() };
    const module = new SubtasksModule(
        {} as never,
        {} as never,
        {} as never,
        workspacesModule as never,
        durableFunctions as never,
        abort as never,
        {} as never,
    );
    hooks = module.beforeStart(ctx, agents as never);
    const archiveAgent = async (id: string) =>
        await agents.updateMetadata(ctx, id, { archivedAt: Date.now() });
    const restoreAgent = async (id: string) =>
        await agents.updateMetadata(ctx, id, { archivedAt: null });
    return {
        ctx,
        configs,
        workspaces,
        archivedWorkspaces,
        metadataUpdates,
        workspacesModule,
        abort,
        archiveAgent,
        restoreAgent,
    };
}

describe("subtask and workspace archival", () => {
    it("archives a workspace-bound subtask's workspace once, without looping back", async () => {
        const { configs, workspaces, archivedWorkspaces, metadataUpdates, abort, archiveAgent } =
            fixture();
        await archiveAgent("resident");
        expect(archivedWorkspaces).toEqual(["taskspace"]);
        expect(workspaces.get("taskspace")?.status).toBe("archiving");
        expect(metadataUpdates).toEqual(["resident"]);
        expect(configs.get("resident")?.metadata?.["archivedAt"]).toEqual(expect.any(Number));
        expect(abort.abort).toHaveBeenCalledWith(expect.anything(), "resident");
    });

    it("archives the resident subtask when its workspace is archived, once", async () => {
        const { ctx, configs, archivedWorkspaces, metadataUpdates, workspacesModule } = fixture();
        await workspacesModule.archive(ctx, "taskspace");
        expect(metadataUpdates).toEqual(["resident"]);
        expect(archivedWorkspaces).toEqual(["taskspace"]);
        const archivedAt = configs.get("resident")?.metadata?.["archivedAt"];
        expect(archivedAt).toEqual(expect.any(Number));
        expect(configs.get("resident")?.metadata?.["version"]).toBe(2);

        await workspacesModule.archive(ctx, "taskspace");
        expect(metadataUpdates).toEqual(["resident"]);
        expect(configs.get("resident")?.metadata?.["archivedAt"]).toBe(archivedAt);
    });

    it("never archives a workspace for a shared-filesystem subtask", async () => {
        const { workspaces, archivedWorkspaces, archiveAgent } = fixture();
        await archiveAgent("shared");
        expect(archivedWorkspaces).toEqual([]);
        expect(workspaces.get("sharedspace")?.status).toBe("ready");
    });

    it("follows only a workspace that names the subtask as its resident", async () => {
        const { ctx, configs, archivedWorkspaces, workspacesModule } = fixture();
        // "other" claims "resident", but "resident" names "taskspace"; neither side follows it.
        await workspacesModule.archive(ctx, "other");
        expect(configs.get("resident")?.metadata?.["archivedAt"]).toBeUndefined();
        expect(archivedWorkspaces).toEqual(["other"]);
    });

    it("refuses to restore a subtask whose workspace was archived", async () => {
        const { archiveAgent, restoreAgent } = fixture();
        await archiveAgent("resident");
        await expect(restoreAgent("resident")).rejects.toThrow(SubtaskInputError);
    });

    it("refuses to restore an archived shared-filesystem subtask too", async () => {
        const { archiveAgent, restoreAgent } = fixture();
        await archiveAgent("shared");
        await expect(restoreAgent("shared")).rejects.toThrow(SubtaskInputError);
    });

    it("leaves a never-archived subtask's metadata updates alone", async () => {
        const { workspaces, restoreAgent } = fixture();
        workspaces.set("taskspace", { id: "taskspace", status: "archived" });
        await expect(restoreAgent("resident")).resolves.toBeUndefined();
    });
});
