import { describe, expect, it, vi } from "vitest";

import type { ModelCatalog } from "../../protocol/index.js";
import { decryptHappyPayload, encryptHappyPayload } from "../happyEncryption.js";
import { HappyMachineClient } from "../HappyMachineClient.js";
import type { HappyConnectionConfiguration } from "../types.js";

const modelCatalog: ModelCatalog = {
    defaultModelId: "gpt-test",
    defaultProviderId: "codex",
    models: [],
    providers: [
        {
            models: [
                {
                    defaultThinkingLevel: "high",
                    id: "gpt-test",
                    name: "GPT Test",
                    thinkingLevels: ["low", "high"],
                },
            ],
            providerId: "codex",
        },
    ],
};

describe("HappyMachineClient", () => {
    it("registers a Rig-only machine and serves encrypted spawn and workspace RPCs", async () => {
        const machineKey = new Uint8Array(32).fill(4);
        const configuration: HappyConnectionConfiguration = {
            credentials: {
                encryption: {
                    machineKey,
                    publicKey: new Uint8Array(32).fill(5),
                    type: "dataKey",
                },
                token: "token",
            },
            credentialsPath: "/tmp/access.key",
            happyHome: "/tmp/happy",
            imported: false,
            machineId: "rig-machine-1",
            serverUrl: "https://happy.example",
        };
        const socket = new FakeMachineSocket();
        const request = vi.fn<typeof fetch>(async (_input, init) => {
            const body = JSON.parse(String(init?.body)) as Record<string, string>;
            const metadata = decryptHappyPayload(
                machineKey,
                "dataKey",
                Buffer.from(body.metadata!, "base64"),
            );
            expect(metadata).toMatchObject({
                capabilities: { newSession: true, resume: false, worktrees: true },
                cliAvailability: { claude: false, codex: false, rig: true },
                defaults: { permissionMode: "auto" },
                machineKind: "rig",
                models: [
                    {
                        id: "gpt-test",
                        name: "GPT Test",
                        providerId: "codex",
                        providerKind: "codex",
                    },
                ],
                rigOnly: true,
                sessionCreation: {
                    idempotencyKey: "clientRequestId",
                    pendingRetryAfterMs: 2_000,
                },
            });
            return Response.json({
                machine: { daemonStateVersion: 0, metadataVersion: 0 },
            });
        });
        const spawnSession = vi.fn(async () => ({
            sessionId: "happy-session-1",
            type: "success" as const,
        }));
        const listWorkspaces = vi.fn(async () => ({
            type: "success" as const,
            workspaces: [
                {
                    id: "workspace-1",
                    name: "Steady River",
                    path: "/workspace/steady-river",
                    status: "ready",
                },
            ],
        }));
        const client = new HappyMachineClient({
            configuration,
            fetch: request,
            listWorkspaces,
            modelCatalog,
            socketFactory: (_url, options) => {
                socket.options = options;
                return socket;
            },
            spawnSession,
            supportsWorktrees: true,
        });

        client.start();
        await waitFor(() => socket.connected);

        expect(socket.options).toMatchObject({
            auth: { clientType: "machine-scoped", machineId: "rig-machine-1" },
            path: "/v1/updates",
        });
        expect(socket.emitted).toContainEqual([
            "rpc-register",
            { method: "rig-machine-1:spawn-happy-session" },
        ]);
        expect(socket.emitted).toContainEqual([
            "rpc-register",
            { method: "rig-machine-1:list-happy-workspaces" },
        ]);
        const params = Buffer.from(
            encryptHappyPayload(machineKey, "dataKey", {
                agent: "rig",
                clientRequestId: "request-1",
                directory: "/workspace",
                type: "spawn-in-directory",
            }),
        ).toString("base64");
        const encryptedResponse = await socket.requestRpc({
            method: "rig-machine-1:spawn-happy-session",
            params,
        });

        expect(spawnSession).toHaveBeenCalledWith(
            expect.objectContaining({ agent: "rig" }),
            expect.any(AbortSignal),
        );
        expect(
            decryptHappyPayload(machineKey, "dataKey", Buffer.from(encryptedResponse, "base64")),
        ).toEqual({ sessionId: "happy-session-1", type: "success" });

        const encryptedListResponse = await socket.requestRpc({
            method: "rig-machine-1:list-happy-workspaces",
            params: Buffer.from(
                encryptHappyPayload(machineKey, "dataKey", { directory: "/workspace" }),
            ).toString("base64"),
        });
        expect(listWorkspaces).toHaveBeenCalledWith({ directory: "/workspace" });
        expect(
            decryptHappyPayload(
                machineKey,
                "dataKey",
                Buffer.from(encryptedListResponse, "base64"),
            ),
        ).toEqual({
            type: "success",
            workspaces: [
                {
                    id: "workspace-1",
                    name: "Steady River",
                    path: "/workspace/steady-river",
                    status: "ready",
                },
            ],
        });
        client.close();
    });
});

class FakeMachineSocket {
    connected = false;
    emitted: unknown[][] = [];
    listeners = new Map<string, (...values: any[]) => void>();
    options: unknown;

    connect(): void {
        this.connected = true;
        this.listeners.get("connect")?.();
    }

    disconnect(): void {
        this.connected = false;
    }

    emit(event: string, ...values: unknown[]): void {
        this.emitted.push([event, ...values]);
    }

    on(event: string, listener: (...values: any[]) => void): void {
        this.listeners.set(event, listener);
    }

    requestRpc(request: unknown): Promise<string> {
        return new Promise((resolve) => this.listeners.get("rpc-request")?.(request, resolve));
    }
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for Happy machine client.");
}
