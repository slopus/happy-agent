import { describe, expect, it } from "vitest";

import type { HappyConnectionConfiguration } from "../../sources/happy/HappyCredentials.js";
import {
    HappyComputerRemovalError,
    removeHappyComputer,
    type HappyPublishedSession,
} from "../../sources/happy/removeHappyComputer.js";

const configuration: HappyConnectionConfiguration = {
    credentialFingerprint: "fingerprint",
    credentials: { encryption: { secret: new Uint8Array(32), type: "legacy" }, token: "token" },
    credentialsPath: "/unused/access.key",
    happyHome: "/unused",
    imported: false,
    machineId: "machine-1",
    serverUrl: "https://happy.test",
};

const sessions: HappyPublishedSession[] = [
    { agentId: "agent-a", remoteSessionId: "remote-a" },
    { agentId: "agent-b", remoteSessionId: "remote-b" },
    { agentId: "agent-c", remoteSessionId: "remote-c" },
];

/** Answers each DELETE by path and records the order Happy saw them in. */
function happy(answer: (path: string) => number | Error = () => 200) {
    const requests: string[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        requests.push(`${init?.method ?? "GET"} ${path}`);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
        const status = answer(path);
        if (status instanceof Error) throw status;
        return new Response(status === 200 ? '{"success":true}' : '{"error":"x"}', { status });
    };
    return { fetch: fetch as typeof globalThis.fetch, requests };
}

async function remove(
    fetch: typeof globalThis.fetch,
    published: readonly HappyPublishedSession[] = sessions,
    machineId: string | null = "machine-1",
) {
    const removed: string[] = [];
    const { machineId: _machineId, ...withoutMachine } = configuration;
    const outcome = removeHappyComputer({
        configuration: machineId === null ? withoutMachine : { ...configuration, machineId },
        fetch,
        onSessionRemoved: async (session) => {
            removed.push(session.agentId);
        },
        sessions: published,
        version: "test",
    });
    return { outcome, removed };
}

describe("removeHappyComputer", () => {
    it("deletes the machine, then every recorded session, counting 404 as already gone", async () => {
        // Happy deleted remote-b along with the machine; an older Happy kept the rest.
        const server = happy((path) => (path === "/v1/sessions/remote-b" ? 404 : 200));
        const { outcome, removed } = await remove(server.fetch);
        await expect(outcome).resolves.toBe("removed");
        expect(removed.sort()).toEqual(["agent-a", "agent-b", "agent-c"]);
        expect(server.requests[0]).toBe("DELETE /v1/machines/machine-1");
        expect(server.requests.slice(1).sort()).toEqual([
            "DELETE /v1/sessions/remote-a",
            "DELETE /v1/sessions/remote-b",
            "DELETE /v1/sessions/remote-c",
        ]);
    });

    it("stops before any session when the machine is not confirmed, and resumes after it", async () => {
        const unreachable = happy((path) =>
            path === "/v1/machines/machine-1" ? new TypeError("fetch failed") : 200,
        );
        const first = await remove(unreachable.fetch);
        await expect(first.outcome).rejects.toBeInstanceOf(HappyComputerRemovalError);
        expect(first.removed).toEqual([]);
        expect(unreachable.requests).toEqual(["DELETE /v1/machines/machine-1"]);

        // The machine is already gone on the retry, and an unconfirmed session is not forgotten.
        const retry = happy((path) =>
            path === "/v1/machines/machine-1" ? 404 : path === "/v1/sessions/remote-a" ? 503 : 200,
        );
        const retried = await remove(retry.fetch, sessions.slice(0, 1));
        await expect(retried.outcome).rejects.toBeInstanceOf(HappyComputerRemovalError);
        expect(retried.removed).toEqual([]);
        expect(retry.requests).toEqual([
            "DELETE /v1/machines/machine-1",
            "DELETE /v1/sessions/remote-a",
        ]);
    });

    it("stops asking Happy once one session deletion fails", async () => {
        const many = Array.from({ length: 40 }, (_, index) => ({
            agentId: `agent-${String(index)}`,
            remoteSessionId: `remote-${String(index)}`,
        }));
        const server = happy((path) => (path.startsWith("/v1/sessions/") ? 500 : 200));
        const { outcome } = await remove(server.fetch, many);
        await expect(outcome).rejects.toBeInstanceOf(HappyComputerRemovalError);
        // Only the session requests already in flight when the first one failed were sent.
        expect(server.requests.length).toBeLessThanOrEqual(1 + 8);
    });

    it("reports credentials Happy rejects and asks nothing more", async () => {
        const machine = happy(() => 401);
        await expect((await remove(machine.fetch)).outcome).resolves.toBe("credentials_rejected");
        expect(machine.requests).toEqual(["DELETE /v1/machines/machine-1"]);

        const session = happy((path) => (path === "/v1/sessions/remote-a" ? 403 : 200));
        await expect((await remove(session.fetch, sessions.slice(0, 1))).outcome).resolves.toBe(
            "credentials_rejected",
        );
    });

    it("removes nothing but sessions when the daemon never had a machine identity", async () => {
        const server = happy();
        await expect(
            (await remove(server.fetch, sessions.slice(0, 1), null)).outcome,
        ).resolves.toBe("removed");
        expect(server.requests).toEqual(["DELETE /v1/sessions/remote-a"]);
    });
});
