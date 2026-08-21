import { createServer, type Server, Socket } from "node:net";

import { GhosttyTerminal } from "@slopus/happy-terminal-gym";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RemoteTerminalProtocolClient } from "./RemoteTerminalProtocolClient.js";
import { RemoteTerminalProtocolServer } from "./RemoteTerminalProtocolServer.js";
import type { RemoteTerminalGridState, RemoteTerminalReplica } from "./types.js";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("remote terminal client/server protocol", () => {
    it("replays arbitrary VT byte boundaries into a real client Ghostty and resumes after reconnect", async () => {
        const canonical = await GhosttyTerminal.create(40, 6);
        const replica = await GhosttyTerminal.create(40, 6);
        cleanups.push(
            () => canonical.close(),
            () => replica.close(),
        );
        const input: Buffer[] = [];
        const server = new RemoteTerminalProtocolServer({
            initialCols: 40,
            initialRows: 6,
            onInput(data) {
                input.push(Buffer.from(data));
            },
            onResize(cols, rows) {
                canonical.resize(cols, rows);
            },
        });
        const endpoint = await listen(server);
        const firstOutput = Buffer.from(
            "\x1b]0;hybrid\x07\x1b[2J\x1b[H\x1b[32mwide:界 emoji:🙂 e\u0301\x1b[0m",
        );
        canonical.writeBytes(firstOutput);
        for (const byte of firstOutput) server.publishOutput(Uint8Array.of(byte));

        const client = new RemoteTerminalProtocolClient({
            clientId: "client-a",
            replica: ghosttyReplica(replica),
            stream: await endpoint.connect(),
        });
        await client.ready;
        await vi.waitFor(async () => {
            expect((await replica.snapshot()).text).toBe((await canonical.snapshot()).text);
        });
        expect((await replica.snapshot()).title).toBe("hybrid");

        client.writeInput("hello");
        await vi.waitFor(() => expect(Buffer.concat(input).toString()).toBe("hello"));
        const resumeOutputOffset = client.appliedOutputOffset;
        const epoch = client.epoch;
        const inputLease = client.inputLease;
        client.close();

        const secondOutput = Buffer.from("\r\nreconnected");
        canonical.writeBytes(secondOutput);
        server.publishOutput(secondOutput);
        const resumed = new RemoteTerminalProtocolClient({
            clientId: "client-a",
            ...(epoch === undefined ? {} : { epoch }),
            ...(inputLease === undefined ? {} : { inputLease }),
            replica: ghosttyReplica(replica),
            resumeInputSequence: 1,
            resumeOutputOffset,
            stream: await endpoint.connect(),
        });
        await resumed.ready;
        await vi.waitFor(async () => {
            expect((await replica.snapshot()).text).toBe((await canonical.snapshot()).text);
        });
        expect(resumed.mode).toBe("vt");
        expect(resumed.appliedOutputOffset).toBe(firstOutput.length + secondOutput.length);
    }, 60_000);

    it("isolates a slow client by switching it to a coalescible semantic keyframe", async () => {
        let releaseSlow!: () => void;
        const slowGate = new Promise<void>((resolve) => {
            releaseSlow = resolve;
        });
        const modes: string[] = [];
        const fastBytes: Buffer[] = [];
        const slowGrids: RemoteTerminalGridState[] = [];
        const server = new RemoteTerminalProtocolServer({
            initialCols: 8,
            initialRows: 1,
            maxUnacknowledgedBytes: 96,
            wireChunkBytes: 96,
            onInput() {},
            onResize() {},
        });
        const endpoint = await listen(server);
        const fast = new RemoteTerminalProtocolClient({
            clientId: "fast",
            creditBytes: 96,
            replica: {
                applyGrid() {},
                applyVt(data) {
                    fastBytes.push(Buffer.from(data));
                },
                resize() {},
            },
            stream: await endpoint.connect(),
        });
        const slow = new RemoteTerminalProtocolClient({
            clientId: "slow",
            creditBytes: 96,
            onMode: (mode) => modes.push(mode),
            replica: {
                applyGrid(state) {
                    slowGrids.push(state);
                },
                async applyVt() {
                    await slowGate;
                },
                resize() {},
            },
            stream: await endpoint.connect(),
        });
        await Promise.all([fast.ready, slow.ready]);

        server.publishOutput(Buffer.from("a".repeat(32)));
        await vi.waitFor(() => expect(Buffer.concat(fastBytes).length).toBe(32));
        server.publishOutput(Buffer.from("b".repeat(80)));
        server.publishGrid(gridState("LATEST", 0, 112));
        releaseSlow();
        await vi.waitFor(() => expect(slowGrids.at(-1)?.title).toBe("LATEST"));
        await vi.waitFor(() => expect(Buffer.concat(fastBytes).length).toBe(112));

        expect(modes).toContain("grid");
        expect(slow.mode).toBe("grid");
        expect(fast.mode).toBe("vt");
        expect(server.metrics.wireBytes).toBeLessThan(server.metrics.payloadBytes + 2_000);
    });

    it("uses resize barriers, deduplicates input, pages scrollback, and compresses dense output", async () => {
        const operations: string[] = [];
        const inputs: string[] = [];
        const server = new RemoteTerminalProtocolServer({
            initialCols: 80,
            initialRows: 24,
            onInput(data) {
                inputs.push(Buffer.from(data).toString());
            },
            onResize(cols, rows) {
                operations.push(`server-resize:${cols}x${rows}`);
            },
            onScrollback(start, count) {
                return {
                    baseRow: 9_000,
                    count,
                    historyEpoch: "history-a",
                    historyRevision: 7,
                    rows: gridState("page", 0).rows,
                    start,
                    totalRows: 10_000,
                };
            },
        });
        const endpoint = await listen(server);
        const client = new RemoteTerminalProtocolClient({
            clientId: "ordered",
            replica: {
                applyGrid() {},
                applyVt(data) {
                    operations.push(`output:${Buffer.from(data).toString()}`);
                },
                resize(cols, rows) {
                    operations.push(`client-resize:${cols}x${rows}`);
                },
            },
            stream: await endpoint.connect(),
        });
        await client.ready;
        server.publishOutput(Buffer.from("before"));
        client.resize(100, 30);
        client.writeInput("once");
        const dense = Buffer.from("dense-redraw-".repeat(10_000));
        const beforeWire = server.metrics.wireBytes;
        server.publishOutput(dense);
        await vi.waitFor(() => expect(inputs).toEqual(["once"]));
        const page = await client.requestScrollback(9_500, 500);
        await vi.waitFor(() => expect(operations).toContain("client-resize:100x30"));

        expect(operations.indexOf("output:before")).toBeLessThan(
            operations.indexOf("client-resize:100x30"),
        );
        expect(page).toMatchObject({ count: 500, start: 9_500, totalRows: 10_000 });
        expect(server.metrics.compressedPackets).toBeGreaterThan(0);
        expect(server.metrics.wireBytes - beforeWire).toBeLessThan(dense.length / 20);
    });

    it("falls back on parser or replay mismatch and coalesces unacknowledged grid revisions", async () => {
        let releasePatch!: () => void;
        const patchGate = new Promise<void>((resolve) => {
            releasePatch = resolve;
        });
        const grids: RemoteTerminalGridState[] = [];
        let applications = 0;
        const server = new RemoteTerminalProtocolServer({
            initialCols: 8,
            initialRows: 1,
            maxReplayBytes: 8,
            onInput() {},
            onResize() {},
            parserFingerprint: "server-parser",
        });
        server.publishOutput(Buffer.from("history-that-will-be-evicted"));
        server.publishGrid(
            gridState("INITIAL", 0, Buffer.byteLength("history-that-will-be-evicted")),
        );
        const endpoint = await listen(server);
        const client = new RemoteTerminalProtocolClient({
            clientId: "fallback",
            epoch: server.epoch,
            parserFingerprint: "different-parser",
            replica: {
                async applyGrid(state) {
                    grids.push(state);
                    applications += 1;
                    if (applications === 2) await patchGate;
                },
                applyVt() {
                    throw new Error("Mismatched parsers must not use VT replay.");
                },
                resize() {},
            },
            resumeOutputOffset: 0,
            stream: await endpoint.connect(),
        });
        await client.ready;
        await vi.waitFor(() => expect(grids.at(-1)?.title).toBe("INITIAL"));

        server.publishGrid(gridState("PATCH-1", 0));
        await vi.waitFor(() => expect(grids.at(-1)?.title).toBe("PATCH-1"));
        server.publishGrid(gridState("SKIPPED-2", 0));
        server.publishGrid(gridState("LATEST-3", 0));
        releasePatch();
        await vi.waitFor(() => expect(grids.at(-1)?.title).toBe("LATEST-3"));

        expect(client.mode).toBe("grid");
        expect(grids.map((grid) => grid.title)).toEqual(["INITIAL", "PATCH-1", "LATEST-3"]);
    });
});

function ghosttyReplica(terminal: GhosttyTerminal): RemoteTerminalReplica {
    return {
        applyGrid() {
            throw new Error("The raw replay test must not fall back to a grid.");
        },
        applyVt(data) {
            terminal.writeBytes(data);
        },
        resize(cols, rows) {
            terminal.resize(cols, rows);
        },
    };
}

function gridState(
    title: string,
    revision: number,
    coversOutputOffset = 0,
): RemoteTerminalGridState {
    return {
        cols: 8,
        coversOutputOffset,
        cursor: { visible: true, x: 0, y: 0 },
        palette: [],
        revision,
        rows: [
            {
                cells: [...title].map((text, x) => ({ styleId: 0, text, width: 1 as const, x })),
                wrapped: false,
            },
        ],
        startRow: 0,
        styles: [{ hyperlink: null }],
        title,
        totalRows: 1,
    };
}

async function listen(protocol: RemoteTerminalProtocolServer): Promise<{
    connect: () => Promise<Socket>;
}> {
    const sockets = new Set<Socket>();
    const network = createServer((socket) => {
        sockets.add(socket);
        protocol.attach(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
        network.once("error", reject);
        network.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(() => closeServer(network, sockets));
    const address = network.address();
    if (address === null || typeof address === "string") throw new Error("Missing TCP address.");
    return {
        connect: () =>
            new Promise((resolve, reject) => {
                const socket = new Socket();
                socket.once("error", reject);
                socket.connect(address.port, "127.0.0.1", () => {
                    socket.off("error", reject);
                    resolve(socket);
                });
            }),
    };
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(() => resolve()));
}
