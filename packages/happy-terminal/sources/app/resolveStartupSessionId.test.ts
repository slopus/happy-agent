import type { HappyAgentClient, Project } from "@slopus/happy-agent-client";
import { describe, expect, it, vi } from "vitest";

import { agentCatalogEntry } from "./agentCatalogTestFixture.js";
import { resolveStartupSessionId } from "./resolveStartupSessionId.js";
import type { StartupStatusApp } from "./StartupStatusApp.js";

describe("resolveStartupSessionId", () => {
    it("selects the newest agent owned by the current project", async () => {
        const older = agentCatalogEntry({ id: "older", updatedAt: 10 }).agent;
        const newer = agentCatalogEntry({ id: "newer", updatedAt: 20 }).agent;
        const client = {
            listProjects: vi.fn(async () => ({
                projects: [
                    {
                        agents: [older, newer],
                        compute: { path: "/workspace", type: "host" },
                        id: "project-1",
                    } as Project,
                ],
            })),
            listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        } as unknown as HappyAgentClient;

        const selected = await resolveStartupSessionId({
            client,
            cwd: "/workspace",
            selection: {
                command: "resume",
                selection: { all: false, last: true },
            },
            startup: { setStatus: vi.fn() } as unknown as StartupStatusApp,
        });

        expect(selected).toBe("newer");
    });

    it("does not synthesize the removed fork endpoint", async () => {
        const client = {
            listProjects: vi.fn(async () => ({
                projects: [
                    {
                        agents: [agentCatalogEntry({ id: "agent-1" }).agent],
                        compute: { path: "/workspace", type: "host" },
                        id: "project-1",
                    } as Project,
                ],
            })),
            listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        } as unknown as HappyAgentClient;

        await expect(
            resolveStartupSessionId({
                client,
                cwd: "/workspace",
                selection: {
                    command: "fork",
                    selection: { all: false, last: true },
                },
                startup: { setStatus: vi.fn() } as unknown as StartupStatusApp,
            }),
        ).rejects.toThrow("does not expose agent forking");
    });
});
