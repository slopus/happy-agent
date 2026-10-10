import { connectTerminalWebSocket, createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("terminal resource matrix", () => {
    it("T001 opens a running root terminal with default geometry", async () => {
        const { gym, workspaceId } = await startedGym();
        const terminal = (await gym.client.openTerminal(workspaceId, { command: "sleep 30" }))
            .terminal;

        expect(terminal).toMatchObject({
            workspaceId,
            status: "running",
            cols: 80,
            rows: 24,
            colorScheme: "dark",
            exitCode: null,
        });
    });

    it("T002 applies explicit geometry and light color", async () => {
        const { gym, workspaceId } = await startedGym();
        const terminal = (
            await gym.client.openTerminal(workspaceId, {
                command: "sleep 30",
                cols: 120,
                rows: 40,
                colorScheme: "light",
            })
        ).terminal;

        expect(terminal).toMatchObject({
            cols: 120,
            rows: 40,
            colorScheme: "light",
        });
    });

    it("T003 accepts a relative working directory within the workspace", async () => {
        const { gym, workspaceId } = await startedGym();
        const terminal = (
            await gym.client.openTerminal(workspaceId, {
                command: "sleep 30",
                cwd: ".",
            })
        ).terminal;

        expect(terminal.status).toBe("running");
        expect(terminal.workspaceId).toBe(workspaceId);
    });

    it("T004 accepts zero and bounded scrollback settings", async () => {
        const { gym, workspaceId } = await startedGym();
        const empty = (
            await gym.client.openTerminal(workspaceId, {
                command: "sleep 30",
                maxScrollback: 0,
            })
        ).terminal;
        const bounded = (
            await gym.client.openTerminal(workspaceId, {
                command: "sleep 30",
                maxScrollback: 100_000,
            })
        ).terminal;

        expect(empty.status).toBe("running");
        expect(bounded.status).toBe("running");
        expect(bounded.id).not.toBe(empty.id);
    });

    it("T005 gives simultaneous terminals unique IDs, epochs, and versions", async () => {
        const { gym, workspaceId } = await startedGym();
        const first = (await gym.client.openTerminal(workspaceId, { command: "sleep 30" }))
            .terminal;
        const second = (await gym.client.openTerminal(workspaceId, { command: "sleep 30" }))
            .terminal;

        expect(first.id).not.toBe(second.id);
        expect(first.epoch).not.toBe(second.epoch);
        expect(first.version).not.toBe(second.version);
    });

    it("T006 echoes an open mutation in terminal.created", async () => {
        const { gym, workspaceId } = await startedGym();
        const mutationId = "terminal-matrix-open";
        const stream = gym.stream();
        await stream.opened();
        const terminal = (
            await gym.client.openTerminal(workspaceId, {
                command: "sleep 30",
                mutationId,
            })
        ).terminal;
        const event = await gym.waitForEvent(
            (candidate) =>
                candidate.type === "terminal.created" &&
                candidate.payload.terminal.id === terminal.id,
            "terminal.created",
        );

        expect(event.payload).toMatchObject({
            mutationId,
            terminal: { id: terminal.id, version: terminal.version },
        });
        await stream.close();
    });

    it("T007 lists only the terminals belonging to the requested workspace", async () => {
        const { gym, workspaceId } = await startedGym();
        const first = (await gym.client.openTerminal(workspaceId, { command: "sleep 30" }))
            .terminal;
        const second = (await gym.client.openTerminal(workspaceId, { command: "sleep 30" }))
            .terminal;
        const listed = await gym.client.listTerminals(workspaceId);

        expect(listed.terminals.map(({ id }) => id)).toEqual(
            expect.arrayContaining([first.id, second.id]),
        );
    });

    it("T008 resizes a running terminal and chains its version", async () => {
        const { gym, workspaceId } = await startedGym();
        const initial = (
            await gym.client.openTerminal(workspaceId, {
                command: "sleep 30",
                cols: 80,
                rows: 24,
            })
        ).terminal;
        const resized = (
            await gym.client.resizeTerminal(workspaceId, initial.id, {
                cols: 100,
                rows: 30,
                mutationId: "terminal-matrix-resize",
            })
        ).terminal;

        expect(resized).toMatchObject({
            id: initial.id,
            cols: 100,
            rows: 30,
            status: "running",
        });
        expect(resized.version).not.toBe(initial.version);
    });

    it("T009 treats an identical resize as a no-op", async () => {
        const { gym, workspaceId } = await startedGym();
        const initial = (
            await gym.client.openTerminal(workspaceId, {
                command: "sleep 30",
                cols: 91,
                rows: 27,
            })
        ).terminal;
        const unchanged = (
            await gym.client.resizeTerminal(workspaceId, initial.id, {
                cols: 91,
                rows: 27,
            })
        ).terminal;

        expect(unchanged).toEqual(initial);
    });

    it("T010 emits terminal.updated for a resize", async () => {
        const { gym, workspaceId } = await startedGym();
        const stream = gym.stream();
        await stream.opened();
        const initial = (await gym.client.openTerminal(workspaceId, { command: "sleep 30" }))
            .terminal;
        const resized = (
            await gym.client.resizeTerminal(workspaceId, initial.id, {
                cols: 101,
                rows: 31,
            })
        ).terminal;
        const event = await gym.waitForEvent(
            (candidate) =>
                candidate.type === "terminal.updated" &&
                candidate.payload.terminalId === initial.id &&
                candidate.payload.version === resized.version,
            "terminal.updated resize",
        );

        expect(event.payload).toMatchObject({
            previousVersion: initial.version,
            version: resized.version,
            changes: { cols: 101, rows: 31 },
        });
        await stream.close();
    });

    it("T011 stops a running terminal and records its exit", async () => {
        const { gym, workspaceId } = await startedGym();
        const initial = (await gym.client.openTerminal(workspaceId, { command: "sleep 30" }))
            .terminal;
        const stopped = (await gym.client.stopTerminal(workspaceId, initial.id)).terminal;

        expect(stopped).toMatchObject({
            id: initial.id,
            status: "exited",
            exitCode: expect.any(Number),
        });
        expect(stopped.version).not.toBe(initial.version);
    });

    it("T012 emits terminal.updated when a terminal exits", async () => {
        const { gym, workspaceId } = await startedGym();
        const stream = gym.stream();
        await stream.opened();
        const initial = (await gym.client.openTerminal(workspaceId, { command: "sleep 30" }))
            .terminal;
        const stopped = (await gym.client.stopTerminal(workspaceId, initial.id)).terminal;
        const event = await gym.waitForEvent(
            (candidate) =>
                candidate.type === "terminal.updated" &&
                candidate.payload.terminalId === initial.id &&
                candidate.payload.changes.status === "exited",
            "terminal.updated exit",
        );

        expect(event.payload).toMatchObject({
            previousVersion: initial.version,
            version: stopped.version,
            changes: { status: "exited", exitCode: stopped.exitCode },
        });
        await stream.close();
    });

    it("T013 retains exited terminals in the list", async () => {
        const { gym, workspaceId } = await startedGym();
        const initial = (await gym.client.openTerminal(workspaceId, { command: "sleep 30" }))
            .terminal;
        await gym.client.stopTerminal(workspaceId, initial.id);
        const listed = await gym.client.listTerminals(workspaceId);

        expect(listed.terminals).toEqual([
            expect.objectContaining({ id: initial.id, status: "exited" }),
        ]);
    });

    it("T014 rejects an invalid terminal size without changing the terminal", async () => {
        const { gym, workspaceId } = await startedGym();
        const initial = (await gym.client.openTerminal(workspaceId, { command: "sleep 30" }))
            .terminal;

        await expect(
            gym.client.resizeTerminal(workspaceId, initial.id, { cols: 501, rows: 24 }),
        ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        await expect(gym.client.listTerminals(workspaceId)).resolves.toMatchObject({
            terminals: [expect.objectContaining(initial)],
        });
    });

    it("T015 rejects an invalid open-terminal geometry", async () => {
        const { gym, workspaceId } = await startedGym();

        await expect(
            gym.client.openTerminal(workspaceId, { command: "sleep 30", cols: 0 }),
        ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        await expect(gym.client.listTerminals(workspaceId)).resolves.toEqual({ terminals: [] });
    });

    it("T016 reports a missing terminal with a stable not-found error", async () => {
        const { gym, workspaceId } = await startedGym();

        await expect(
            gym.client.stopTerminal(workspaceId, "missing-terminal"),
        ).rejects.toMatchObject({ status: 404, code: "not_found" });
    });

    it("T017 reports a missing terminal on resize with a stable not-found error", async () => {
        const { gym, workspaceId } = await startedGym();

        await expect(
            gym.client.resizeTerminal(workspaceId, "missing-terminal", { cols: 80, rows: 24 }),
        ).rejects.toMatchObject({ status: 404, code: "not_found" });
    });

    it("T018 rejects a terminal ID from another workspace", async () => {
        const { gym, workspaceId } = await startedGym();
        const childId = await readyChildWorkspace(gym, workspaceId);
        const terminal = (await gym.client.openTerminal(workspaceId, { command: "sleep 30" }))
            .terminal;

        await expect(
            gym.client.resizeTerminal(childId, terminal.id, { cols: 90, rows: 25 }),
        ).rejects.toMatchObject({ status: 404, code: "not_found" });
    });

    it("T019 gives each child workspace an independent terminal collection", async () => {
        const { gym, workspaceId } = await startedGym();
        const childId = await readyChildWorkspace(gym, workspaceId);
        const terminal = (await gym.client.openTerminal(childId, { command: "sleep 30" })).terminal;

        await expect(gym.client.listTerminals(workspaceId)).resolves.toEqual({ terminals: [] });
        await expect(gym.client.listTerminals(childId)).resolves.toMatchObject({
            terminals: [expect.objectContaining({ id: terminal.id, workspaceId: childId })],
        });
    });

    it("T020 resizes and stops a child-workspace terminal independently", async () => {
        const { gym, workspaceId } = await startedGym();
        const childId = await readyChildWorkspace(gym, workspaceId);
        const terminal = (await gym.client.openTerminal(childId, { command: "sleep 30" })).terminal;
        const resized = (
            await gym.client.resizeTerminal(childId, terminal.id, { cols: 110, rows: 35 })
        ).terminal;
        const stopped = (await gym.client.stopTerminal(childId, terminal.id)).terminal;

        expect(resized).toMatchObject({ workspaceId: childId, cols: 110, rows: 35 });
        expect(stopped).toMatchObject({ workspaceId: childId, status: "exited" });
    });

    it("T021 clears runtime terminal rows across a daemon restart", async () => {
        const { gym, workspaceId } = await startedGym();
        const terminal = (await gym.client.openTerminal(workspaceId, { command: "sleep 30" }))
            .terminal;

        await gym.restart();

        expect((await gym.client.listTerminals(workspaceId)).terminals).not.toEqual([
            expect.objectContaining({ id: terminal.id }),
        ]);
    });

    it("T022 exposes a public terminal attachment URL for the typed client", async () => {
        const { gym, workspaceId } = await startedGym();
        const terminal = (await gym.client.openTerminal(workspaceId, { command: "sleep 30" }))
            .terminal;
        const endpoint = gym.client.terminalAttachUrl(workspaceId, terminal.id);

        expect(endpoint).toContain(`/v0/workspaces/${workspaceId}/terminals/${terminal.id}/attach`);
    });

    it("T023 accepts a valid terminal WebSocket attachment and rejects a wrong token", async () => {
        const { gym, workspaceId } = await startedGym();
        const terminal = (await gym.client.openTerminal(workspaceId, { command: "sleep 30" }))
            .terminal;

        await expect(
            connectTerminalWebSocket(gym.client, workspaceId, terminal.id, {
                socketPath: gym.socketPath,
                token: "wrong-token",
            }),
        ).rejects.toThrow(/HTTP (401|404)/);
        const socket = await connectTerminalWebSocket(gym.client, workspaceId, terminal.id, {
            socketPath: gym.socketPath,
            token: gym.token,
        });
        socket.destroy();
    });
});

async function startedGym(): Promise<{ readonly gym: AgentGym; readonly workspaceId: string }> {
    const gym = await createAgentGym({ timeoutMs: 15_000 });
    running.add(gym);
    const project = await gym.waitUntil(
        async () => {
            const projects = await gym.client.listProjects();
            const ready = projects.projects.find(
                (candidate) =>
                    candidate.status === "active" && candidate.initialization.status === "ready",
            );
            return ready;
        },
        "the root project to become ready",
        15_000,
    );
    const workspace = await gym.client.getWorkspace(project.id);
    expect(workspace.workspace.id).toBe(project.id);
    return { gym, workspaceId: project.id };
}

async function readyChildWorkspace(gym: AgentGym, parentId: string): Promise<string> {
    const created = await gym.client.createWorkspace({ name: "matrix-child", parentId });
    return await gym.waitUntil(
        async () => {
            const current = await gym.client.getWorkspace(created.workspace.id);
            if (current.workspace.initialization.status === "failed") {
                throw new Error(
                    `Child initialization failed: ${
                        current.workspace.initialization.error ?? "unknown"
                    }`,
                );
            }
            return current.workspace.initialization.status === "ready"
                ? current.workspace.id
                : undefined;
        },
        "the child workspace to become ready",
        15_000,
    );
}
