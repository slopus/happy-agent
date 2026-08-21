import { createServer, type Server, Socket } from "node:net";

import { GhosttyTerminal } from "@slopus/happy-terminal-gym";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    createGhosttyRemoteTerminalServer,
    GhosttyRemoteTerminalReplica,
    ghosttySnapshotToGrid,
    type GhosttySnapshot,
} from "./GhosttyRemoteTerminal.js";
import { applyGridPatch } from "./applyGridPatch.js";
import { diffGridState } from "./diffGridState.js";
import { RemoteTerminalProtocolClient } from "./RemoteTerminalProtocolClient.js";
import { RemoteTerminalProtocolServer } from "./RemoteTerminalProtocolServer.js";
import type { RemoteTerminalGridState } from "./types.js";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("concrete Ghostty recovery", () => {
    it("deduplicates hyperlinks as semantic styles and patches hyperlink-only changes", () => {
        const previous = {
            ...ghosttySnapshotToGrid(hyperlinkSnapshot("https://one.test"), 8),
            coversOutputOffset: 1,
            revision: 1,
        };
        const next = {
            ...ghosttySnapshotToGrid(hyperlinkSnapshot("javascript:exact()"), 8),
            coversOutputOffset: 1,
            revision: 2,
        };

        expect(previous.styles).toEqual([
            expect.objectContaining({ hyperlink: "https://one.test" }),
            expect.objectContaining({ hyperlink: null }),
        ]);
        expect(previous.rows[0]?.cells.map((cell) => cell.styleId)).toEqual([0, 0, 1]);
        expect(JSON.parse(JSON.stringify(previous))).toEqual(previous);

        const patch = diffGridState(previous, next);
        expect(patch).toBeDefined();
        expect(patch?.rows).toEqual([]);
        expect(patch?.styles).toEqual([
            expect.objectContaining({ hyperlink: "javascript:exact()" }),
            expect.objectContaining({ hyperlink: null }),
        ]);
        expect(applyGridPatch(previous, patch!)).toEqual(next);
    });

    it("preserves hyperlink metadata in keyframes, reconnect recovery, and scrollback", async () => {
        const initial = ghosttySnapshotToGrid(hyperlinkSnapshot("https://initial.test"), 8);
        let current = initial;
        const server = new RemoteTerminalProtocolServer({
            initialCols: 8,
            initialRows: 1,
            onInput() {},
            onResize() {},
            onScrollback(start, count) {
                return {
                    baseRow: 0,
                    count,
                    historyEpoch: "hyperlink-history",
                    historyRevision: 1,
                    palette: current.palette,
                    rows: current.rows,
                    start,
                    styles: current.styles,
                    totalRows: current.totalRows,
                };
            },
        });
        server.publishGrid({ ...initial, coversOutputOffset: 0 });
        const endpoint = await listen(server);
        const firstGrids: RemoteTerminalGridState[] = [];
        const first = new RemoteTerminalProtocolClient({
            capabilities: { grid: true, vt: false },
            clientId: "hyperlink-recovery",
            replica: {
                applyGrid(grid) {
                    firstGrids.push(grid);
                },
                applyVt() {},
                resize() {},
            },
            stream: await endpoint.connect(),
        });
        await first.ready;
        await vi.waitFor(() => expect(firstGrids).toHaveLength(1));
        expect(firstGrids[0]?.styles).toContainEqual(
            expect.objectContaining({ hyperlink: "https://initial.test" }),
        );

        const reconnect = first.reconnectState();
        first.close();
        current = ghosttySnapshotToGrid(hyperlinkSnapshot("file:///tmp/recovered"), 8);
        server.publishGrid({ ...current, coversOutputOffset: 0 });

        const recovered: RemoteTerminalGridState[] = [];
        const resumed = new RemoteTerminalProtocolClient({
            capabilities: { grid: true, vt: false },
            clientId: "hyperlink-recovery",
            ...(reconnect.epoch === undefined ? {} : { epoch: reconnect.epoch }),
            ...(reconnect.inputLease === undefined ? {} : { inputLease: reconnect.inputLease }),
            replica: {
                applyGrid(grid) {
                    recovered.push(grid);
                },
                applyVt() {},
                resize() {},
            },
            resumeInputSequence: reconnect.resumeInputSequence,
            resumeOutputOffset: reconnect.resumeOutputOffset,
            stream: await endpoint.connect(),
        });
        await resumed.ready;
        await vi.waitFor(() => expect(recovered).toHaveLength(1));
        expect(recovered[0]?.styles).toContainEqual(
            expect.objectContaining({ hyperlink: "file:///tmp/recovered" }),
        );

        const scrollback = await resumed.requestScrollback(0, 1);
        expect(scrollback.styles).toContainEqual(
            expect.objectContaining({ hyperlink: "file:///tmp/recovered" }),
        );
        expect(scrollback.rows).toEqual(current.rows);
    });

    it("uses a render-faithful semantic keyframe for wide, combining, styled, and wrapped content", async () => {
        const canonical = await GhosttyTerminal.create(10, 4);
        cleanups.push(() => canonical.close());
        const { driver, protocol } = createGhosttyRemoteTerminalServer(canonical, {
            initialCols: 10,
            initialRows: 4,
            maxUnacknowledgedBytes: 16,
            wireChunkBytes: 16,
            onInput() {},
        });
        cleanups.push(() => driver.close());
        const endpoint = await listen(protocol);
        let releaseRaw!: () => void;
        const rawGate = new Promise<void>((resolve) => {
            releaseRaw = resolve;
        });
        const grids: RemoteTerminalGridState[] = [];
        const client = new RemoteTerminalProtocolClient({
            clientId: "semantic-ghostty",
            creditBytes: 16,
            replica: {
                applyGrid(state) {
                    grids.push(state);
                },
                async applyVt() {
                    await rawGate;
                },
                resize() {},
            },
            stream: await endpoint.connect(),
        });
        await client.ready;
        await driver.publishOutput(
            Buffer.from("\x1b]0;semantic\x07\x1b[1;4;5;7;9;53;31m界e\u0301-abcdefghijklmno\x1b[0m"),
        );
        releaseRaw();
        await vi.waitFor(() => expect(grids).toHaveLength(1));

        const expected = ghosttySnapshotToGrid(await canonical.snapshot(), 10);
        const actual = grids[0]!;
        expect({
            cols: actual.cols,
            cursor: actual.cursor,
            palette: actual.palette,
            rows: actual.rows,
            startRow: actual.startRow,
            styles: actual.styles,
            title: actual.title,
            totalRows: actual.totalRows,
        }).toEqual(expected);
        expect(actual.rows.some((row) => row.wrapped)).toBe(true);
        expect(actual.rows.flatMap((row) => row.cells).some((cell) => cell.width === 2)).toBe(true);
        expect(
            actual.styles.some((style) => style.underline === "single" && style.inverse === true),
        ).toBe(true);
    });

    it("forwards canonical terminal replies once and never forwards replica replies", async () => {
        const canonical = await GhosttyTerminal.create(20, 4);
        const replica = await GhosttyTerminal.create(20, 4);
        cleanups.push(
            () => canonical.close(),
            () => replica.close(),
        );
        const forwarded: Buffer[] = [];
        const replicaGenerated: string[] = [];
        replica.onPtyWrite((data) => replicaGenerated.push(data));
        const { driver, protocol } = createGhosttyRemoteTerminalServer(canonical, {
            initialCols: 20,
            initialRows: 4,
            onInput() {},
            onTerminalResponse(data) {
                forwarded.push(Buffer.from(data));
            },
        });
        cleanups.push(() => driver.close());
        const endpoint = await listen(protocol);
        const client = new RemoteTerminalProtocolClient({
            capabilities: { grid: false, vt: true },
            clientId: "terminal-responses",
            replica: new GhosttyRemoteTerminalReplica(replica),
            stream: await endpoint.connect(),
        });
        await client.ready;
        await driver.publishOutput(Buffer.from("\x1b[c"));
        await vi.waitFor(() => expect(forwarded).toHaveLength(1));
        await vi.waitFor(() => expect(replicaGenerated).toHaveLength(1));
        expect(forwarded[0]).toEqual(Buffer.from(replicaGenerated[0]!));
        expect(forwarded).toHaveLength(1);
    });

    it("forces a fresh attachment to a keyframe after resize, including resize at offset zero", async () => {
        const canonical = await GhosttyTerminal.create(20, 4);
        cleanups.push(() => canonical.close());
        const { driver, protocol } = createGhosttyRemoteTerminalServer(canonical, {
            initialCols: 20,
            initialRows: 4,
            onInput() {},
        });
        cleanups.push(() => driver.close());
        const endpoint = await listen(protocol);
        const controller = new RemoteTerminalProtocolClient({
            clientId: "resize-controller",
            replica: { applyGrid() {}, applyVt() {}, resize() {} },
            stream: await endpoint.connect(),
        });
        await controller.ready;
        await controller.resize(16, 3);
        await driver.publishOutput(Buffer.from("before-resize"));
        await controller.resize(10, 3);
        await driver.publishOutput(
            Buffer.from("\r\n\x1b]8;;https://resize.test\x1b\\after\x1b]8;;\x1b\\界"),
        );

        const recovered: RemoteTerminalGridState[] = [];
        const fresh = new RemoteTerminalProtocolClient({
            clientId: "fresh-after-resize",
            replica: {
                applyGrid(state) {
                    recovered.push(state);
                },
                applyVt() {
                    throw new Error("Fresh attachment must not replay resize history as VT.");
                },
                resize() {},
            },
            stream: await endpoint.connect(),
        });
        await fresh.ready;
        await vi.waitFor(() => expect(recovered).toHaveLength(1));
        expect(fresh.mode).toBe("grid");
        expect(recovered[0]!.cols).toBe(10);
        expect(recovered[0]!.coversOutputOffset).toBe(protocol.outputOffset());
        expect(recovered[0]!.styles).toContainEqual(
            expect.objectContaining({ hyperlink: "https://resize.test" }),
        );
    });

    it("drains canonical parsing before durable exit and fails closed on partial resize", async () => {
        const canonical = await GhosttyTerminal.create(20, 4);
        cleanups.push(() => canonical.close());
        const { driver, protocol } = createGhosttyRemoteTerminalServer(canonical, {
            initialCols: 20,
            initialRows: 4,
            onInput() {},
            onResize() {
                throw new Error("PTY resize failed");
            },
        });
        cleanups.push(() => driver.close());
        const endpoint = await listen(protocol);
        const output: Buffer[] = [];
        const exits: (number | null)[] = [];
        const socket = await endpoint.connect();
        const client = new RemoteTerminalProtocolClient({
            clientId: "driver-exit",
            onExit: (code) => exits.push(code),
            replica: {
                applyGrid() {},
                applyVt(data) {
                    output.push(Buffer.from(data));
                },
                resize() {},
            },
            stream: socket,
        });
        await client.ready;
        const pending = driver.publishOutput(Buffer.from("final-output"));
        await driver.publishExit(0);
        await pending;
        await vi.waitFor(() => expect(exits).toEqual([0]));
        expect(Buffer.concat(output).toString()).toBe("final-output");

        const failedCanonical = await GhosttyTerminal.create(20, 4);
        cleanups.push(() => failedCanonical.close());
        const failedCreated = createGhosttyRemoteTerminalServer(failedCanonical, {
            initialCols: 20,
            initialRows: 4,
            onInput() {},
            onResize() {
                throw new Error("host PTY refused resize");
            },
        });
        cleanups.push(() => failedCreated.driver.close());
        const failedEndpoint = await listen(failedCreated.protocol);
        const failedSocket = await failedEndpoint.connect();
        failedSocket.resume();
        const failed = new RemoteTerminalProtocolClient({
            clientId: "partial-resize",
            replica: { applyGrid() {}, applyVt() {}, resize() {} },
            stream: failedSocket,
        });
        await failed.ready;
        await expect(failed.resize(30, 8)).rejects.toThrow();
        await vi.waitFor(() => expect(failedSocket.destroyed).toBe(true));
    });

    it("bounds output held behind a concrete hung resize", async () => {
        const canonical = await GhosttyTerminal.create(20, 4);
        cleanups.push(() => canonical.close());
        let resizeStarted = false;
        let releaseResize!: () => void;
        const gate = new Promise<void>((resolve) => {
            releaseResize = resolve;
        });
        const { driver, protocol } = createGhosttyRemoteTerminalServer(canonical, {
            initialCols: 20,
            initialRows: 4,
            maxBufferedBytes: 1_024,
            onInput() {},
            async onResize() {
                resizeStarted = true;
                await gate;
            },
        });
        cleanups.push(() => driver.close());
        const endpoint = await listen(protocol);
        const socket = await endpoint.connect();
        socket.resume();
        const client = new RemoteTerminalProtocolClient({
            clientId: "concrete-hung-resize",
            replica: { applyGrid() {}, applyVt() {}, resize() {} },
            stream: socket,
        });
        await client.ready;
        const resized = client.resize(30, 8);
        await vi.waitFor(() => expect(resizeStarted).toBe(true));
        await expect(driver.publishOutput(Buffer.alloc(2_048))).rejects.toThrow("buffer is full");
        releaseResize();
        await expect(resized).rejects.toThrow();
        await vi.waitFor(() => expect(socket.destroyed).toBe(true));
    });

    it("persistently fails the protocol when canonical output parsing fails", async () => {
        const failure = new Error("canonical parser failed");
        const terminal = {
            resize() {},
            snapshot() {
                return {
                    cells: [],
                    cursor: { visible: true, x: 0, y: 0 },
                    rows: [""],
                    scroll: { offset: 0, totalRows: 1, visibleRows: 1 },
                    title: "",
                };
            },
            writeBytes() {
                throw failure;
            },
        };
        const { driver, protocol } = createGhosttyRemoteTerminalServer(terminal, {
            initialCols: 20,
            initialRows: 4,
            onInput() {},
        });
        const endpoint = await listen(protocol);
        const exits: (number | null)[] = [];
        const client = new RemoteTerminalProtocolClient({
            clientId: "canonical-failure",
            onExit: (code) => exits.push(code),
            replica: { applyGrid() {}, applyVt() {}, resize() {} },
            stream: await endpoint.connect(),
        });
        await client.ready;
        await expect(driver.publishOutput(Buffer.from("broken"))).rejects.toThrow(
            "canonical parser failed",
        );
        await expect(driver.publishExit(0)).rejects.toThrow("canonical parser failed");
        expect(() => protocol.publishOutput(Buffer.from("later"))).toThrow(
            "canonical parser failed",
        );
        expect(exits).toEqual([]);

        const late = new RemoteTerminalProtocolClient({
            clientId: "after-canonical-failure",
            replica: { applyGrid() {}, applyVt() {}, resize() {} },
            stream: await endpoint.connect(),
        });
        await expect(late.ready).rejects.toThrow();
    });
});

async function listen(protocol: {
    attach(stream: Socket): () => void;
}): Promise<{ connect: () => Promise<Socket> }> {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
        sockets.add(socket);
        protocol.attach(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(() => closeServer(server, sockets));
    const address = server.address();
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

function hyperlinkSnapshot(hyperlink: string): GhosttySnapshot {
    return {
        cells: [
            snapshotCell(0, "g", hyperlink),
            snapshotCell(1, "o", hyperlink),
            snapshotCell(2, "!", null),
        ],
        cursor: { visible: true, x: 3, y: 0 },
        palette: ["#000000"],
        rows: ["go!"],
        scroll: { offset: 0, totalRows: 1, visibleRows: 1 },
        title: "linked",
        wrappedRows: [false],
    };
}

function snapshotCell(x: number, text: string, hyperlink: string | null) {
    return {
        background: "#000000",
        bold: false,
        dim: false,
        foreground: "#ffffff",
        hyperlink,
        italic: false,
        text,
        width: 1 as const,
        x,
        y: 0,
    };
}
