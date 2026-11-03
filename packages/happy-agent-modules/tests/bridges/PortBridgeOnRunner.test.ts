import { connect, createServer, type Server } from "node:net";

import type { WorkspacePortBridgeListener } from "@slopus/happy-agent-client";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
    BridgeEnding,
    BridgeWebSocket,
    BridgeWebSocketBinding,
} from "../../sources/bridges/index.js";
import { PortBridgeSession } from "../../sources/bridges/impl/PortBridgeSession.js";
import { connectedRunner } from "../support/connectedRunner.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A port bridge on a runner workspace listens on the runner, through the runner's own loopback
 * listener, and admits only that machine's user. The in-process runner here shares this
 * computer's loopback, so a program "on the runner" is a socket opened from the test.
 */
describe("a port bridge on a runner", () => {
    it("listens on the runner and relays an accepted connection to the client", async () => {
        const runner = await connectedRunner(cleanups);
        const { session, endings } = bridge();
        const listener = await session.listen(await runner.runners.machine(runner.runnerId), 0);
        const control = attach(session);
        expect(JSON.parse(control.messages[0] as string)).toMatchObject({ type: "ready" });

        const program = connect(listener.port, "127.0.0.1");
        program.on("error", () => undefined);
        cleanups.push(() => {
            program.destroy();
        });
        const connectionId = await nextConnection(control);
        const carrier = new FakeWebSocket();
        carrier.binding = session.accept(connectionId)!.attach(carrier);

        program.write("ping");
        await vi.waitFor(() => expect(carrier.messages).toEqual([Buffer.from("ping")]));
        const answer = new Promise<string>((resolve) => {
            program.once("data", (data: Buffer) => resolve(data.toString()));
        });
        carrier.binding.message(Buffer.from("pong"));
        await expect(answer).resolves.toBe("pong");
        expect(endings).toEqual([]);
    });

    it("refuses a port in use on the runner, and ends when the runner restarts", async () => {
        const runner = await connectedRunner(cleanups);
        const machine = await runner.runners.machine(runner.runnerId);
        const taken = await listening();
        cleanups.push(() => {
            taken.close();
        });
        await expect(
            bridge().session.listen(machine, (taken.address() as { port: number }).port),
        ).rejects.toMatchObject({ code: "port_unavailable" });

        const { session, endings } = bridge();
        await session.listen(machine, 0);
        const control = attach(session);
        // A dropped connection alone keeps the listener for the runner's lease, so a brief network
        // failure does not close the bridge. A runner that comes back without it does.
        runner.disconnect();
        await runner.restart();
        await runner.connect();
        await vi.waitFor(() => expect(endings).toHaveLength(1));
        expect(endings[0]).toMatchObject({ reason: "failed" });
        expect(control.closedWith?.code).toBe(1011);
    });
});

function bridge(): { session: PortBridgeSession; endings: BridgeEnding[] } {
    const endings: BridgeEnding[] = [];
    const session = new PortBridgeSession({
        ctx: createRootContext().named("port-bridge-on-runner"),
        opened: (listener: WorkspacePortBridgeListener) => ({
            id: "bridgeone",
            workspaceId: "workspaceone",
            kind: "port",
            name: `Port ${String(listener.port)}`,
            status: "open",
            usb: null,
            port: listener,
            closeReason: null,
            version: "01991f3a-6161-7000-8000-8f5061920314",
            createdAt: 0,
            updatedAt: 0,
            closedAt: null,
        }),
        ended: (ending) => endings.push(ending),
    });
    cleanups.push(() =>
        session.end({ reason: "daemon_shutdown", code: 1001, message: "The test ended." }),
    );
    return { session, endings };
}

function attach(session: PortBridgeSession): FakeWebSocket {
    const control = new FakeWebSocket();
    control.binding = session.attach(control);
    return control;
}

async function nextConnection(control: FakeWebSocket): Promise<string> {
    return await vi.waitFor(() => {
        const announced = control.messages
            .filter((message): message is string => typeof message === "string")
            .map((message) => JSON.parse(message) as { type: string; connectionId?: string })
            .find((message) => message.type === "connection");
        if (announced?.connectionId === undefined) throw new Error("No connection yet.");
        return announced.connectionId;
    });
}

async function listening(): Promise<Server> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return server;
}

class FakeWebSocket implements BridgeWebSocket {
    readonly bufferedAmount = 0;
    readonly messages: (Buffer | string)[] = [];
    closedWith: { readonly code: number; readonly reason: string } | undefined;
    binding: BridgeWebSocketBinding | undefined;

    send(data: Uint8Array | string): void {
        if (this.closedWith !== undefined) return;
        this.messages.push(typeof data === "string" ? data : Buffer.from(data));
    }

    close(code: number, reason: string): void {
        if (this.closedWith !== undefined) return;
        this.closedWith = { code, reason };
    }
}
