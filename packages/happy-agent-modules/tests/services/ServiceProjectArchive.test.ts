import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { definition, servicesHarness } from "./support/servicesHarness.js";

async function managedProject(f: Awaited<ReturnType<typeof servicesHarness>>) {
    const root = join(f.projects.managedProjectsDirectory, "managed-preview");
    expect(relative(f.config.projectsHome, root)).toBe("managed-preview");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "server.js"), "// selected fixture input\n");
    const project = await f.projects.create(f.ctx, {
        id: "aamanagedproject",
        repositoryRef: root,
        name: "Managed preview",
        kind: "regular",
        remoteSource: { kind: "git", url: "https://example.com/fixture.git" },
    });
    await f.projects.markInitializationReady(f.ctx, project.id);
    const agentId = "aamanagedowner";
    f.agentConfigs.set(agentId, { modules: { compute: { cwd: root } } });
    await f.projects.attachAgent(f.ctx, project.id, agentId);
    return { project, root, agentId };
}

describe("project-root service cleanup", () => {
    it("retains the real managed root until the service owner confirms cleanup", async () => {
        const f = await servicesHarness();
        const confirmation = vi.spyOn(f.services, "confirmWorkspaceStopped");
        try {
            const { project, root, agentId } = await managedProject(f);
            const service = await f.services.start(f.ctx, agentId, definition);
            await vi.waitFor(async () =>
                expect((await f.services.get(f.ctx, project.id, service.id)).status).toBe(
                    "running",
                ),
            );
            confirmation.mockRejectedValue(new Error("Cleanup proof temporarily unavailable."));
            expect((await f.projects.archive(f.ctx, project.id)).status).toBe("archived");
            await vi.waitFor(() => expect(confirmation).toHaveBeenCalled());
            expect((await stat(root)).isDirectory()).toBe(true);
            await expect(f.services.start(f.ctx, agentId, definition)).rejects.toThrow(
                /not available|closed/u,
            );
            confirmation.mockRestore();
            await vi.waitFor(
                async () => await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" }),
            );
        } finally {
            confirmation.mockRestore();
            await f.close();
        }
    });

    it("does not delete a restored root after its old cleanup barrier is released", async () => {
        const f = await servicesHarness();
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered = false;
        try {
            const { project, root, agentId } = await managedProject(f);
            const unsubscribe = f.projects.onBeforeFolderRemoval(async () => {
                entered = true;
                await held;
            });
            await f.projects.archive(f.ctx, project.id);
            await vi.waitFor(() => expect(entered).toBe(true));
            expect((await f.projects.restore(f.ctx, project.id)).status).toBe("active");
            release();
            unsubscribe();
            const service = await f.services.start(f.ctx, agentId, definition);
            await vi.waitFor(async () =>
                expect((await f.services.get(f.ctx, project.id, service.id)).status).toBe(
                    "running",
                ),
            );
            expect((await stat(root)).isDirectory()).toBe(true);
            await f.services.stopAndWait(f.ctx, project.id, service.id);
        } finally {
            release();
            await f.close();
        }
    });
});
