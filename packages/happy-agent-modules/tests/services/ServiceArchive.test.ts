import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { servicesHarness, ownerId, workspaceId, definition } from "./support/servicesHarness.js";

describe("workspace service cleanup before folder removal", () => {
    it("publishes abort without holding the shared database through service teardown", async () => {
        const f = await servicesHarness();
        let stopping: Promise<void> | undefined;
        let timeout: NodeJS.Timeout | undefined;
        try {
            const service = await f.services.start(f.ctx, ownerId, definition);
            await vi.waitFor(async () =>
                expect((await f.services.get(f.ctx, workspaceId, service.id)).status).toBe(
                    "running",
                ),
            );
            f.holdCleanup();
            stopping = f.abort.abort(f.ctx, ownerId);
            await Promise.race([
                stopping.then(async () => {
                    expect((await f.services.get(f.ctx, workspaceId, service.id)).status).toBe(
                        "stopping",
                    );
                }),
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    "Abort held the shared database through service teardown.",
                                ),
                            ),
                        1000,
                    );
                }),
            ]);
        } finally {
            if (timeout !== undefined) clearTimeout(timeout);
            f.finishCleanup();
            await stopping;
            await f.close();
        }
    });
    it("archives optimistically but retains the real workspace until the service's cleanup is confirmed", async () => {
        const f = await servicesHarness();
        const confirmation = vi.spyOn(f.services, "confirmWorkspaceStopped");
        try {
            const project = await f.projects.get(f.ctx, workspaceId);
            await writeFile(
                join(project!.repositoryRef, "happy.toml"),
                "[workspace]\nkeep_copies_on_archive = false\n",
            );
            const { workspace } = await f.workspaces.reserve(
                f.ctx,
                {
                    id: "aachildworkspace",
                    projectRef: workspaceId,
                    name: "Preview workspace",
                    kind: "directory",
                },
                {
                    pathForStorageKey: (key) =>
                        join(f.config.workspacesHome, project!.storageKey, key),
                },
            );
            expect(relative(project!.repositoryRef, workspace.path).split(sep)[0]).toBe(
                "workspaces",
            );
            await mkdir(workspace.path, { recursive: true });
            await writeFile(join(workspace.path, "server.js"), "// selected fixture input\n");
            await f.workspaces.markReady(f.ctx, { workspaceId: workspace.id });
            const agentId = "aaworkspaceowner";
            f.agentConfigs.set(agentId, { modules: { compute: { cwd: workspace.path } } });
            await f.workspaces.attachAgent(f.ctx, workspace.id, agentId);
            const service = await f.services.start(f.ctx, agentId, definition);
            await vi.waitFor(async () =>
                expect((await f.services.get(f.ctx, workspace.id, service.id)).status).toBe(
                    "running",
                ),
            );
            await expect(
                f.storage.transaction(f.ctx, async (txCtx) => {
                    await f.workspaces.archive(txCtx, workspace.id);
                    throw new Error("rollback");
                }),
            ).rejects.toThrow("rollback");
            expect((await f.workspaces.get(f.ctx, workspace.id))?.status).toBe("ready");
            expect((await f.services.get(f.ctx, workspace.id, service.id)).status).toBe("running");
            expect(f.running[0]!.service.stop).not.toHaveBeenCalled();
            f.holdCleanup();
            confirmation.mockImplementation(async () => {
                await Promise.all(f.running.map(({ service }) => service.completion));
                throw new Error("Internal failure with private path /private/control");
            });
            const archived = await f.workspaces.archive(f.ctx, workspace.id);
            expect(archived.status).toBe("archiving");
            await vi.waitFor(async () => {
                const current = await f.workspaces.get(f.ctx, workspace.id);
                // Cleanup progress must be observable while runtime termination is pending.
                if (current?.status === "archived") return;
                expect(current).toMatchObject({ serviceCleanup: { phase: "stopping_services" } });
            });
            expect(await f.workspaces.get(f.ctx, workspace.id)).toMatchObject({
                status: "archiving",
                serviceCleanup: {
                    phase: "stopping_services",
                    serviceIds: [service.id],
                    error: null,
                },
            });
            expect((await stat(workspace.path)).isDirectory()).toBe(true);
            await expect(f.services.start(f.ctx, agentId, definition)).rejects.toThrow(
                /not available|closed/u,
            );
            try {
                f.finishCleanup();
                await vi.waitFor(async () =>
                    expect(await f.workspaces.get(f.ctx, workspace.id)).toMatchObject({
                        status: "archiving",
                        serviceCleanup: {
                            phase: "blocked",
                            serviceIds: [service.id],
                            error: {
                                code: "service_cleanup_unconfirmed",
                                message:
                                    "Service cleanup is not confirmed. Workspace files have been retained.",
                            },
                        },
                    }),
                );
                expect((await stat(workspace.path)).isDirectory()).toBe(true);
            } finally {
                confirmation.mockRestore();
            }
            await vi.waitFor(async () =>
                expect((await f.workspaces.get(f.ctx, workspace.id))?.status).toBe("archived"),
            );
            expect((await f.workspaces.get(f.ctx, workspace.id))?.serviceCleanup).toBe(null);
            await expect(stat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
            expect(await f.services.get(f.ctx, workspace.id, service.id)).toMatchObject({
                status: "killed",
            });
        } finally {
            confirmation.mockRestore();
            f.finishCleanup();
            await f.close();
        }
    });
});
