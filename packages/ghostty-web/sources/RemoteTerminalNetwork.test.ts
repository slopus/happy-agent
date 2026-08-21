import { createServer, Socket } from "node:net";
import { performance } from "node:perf_hooks";

import { GhosttyTerminal } from "@slopus/happy-terminal-gym";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    createGhosttyRemoteTerminalServer,
    GhosttyRemoteTerminalReplica,
} from "./GhosttyRemoteTerminal.js";
import { RemoteTerminalProtocolClient } from "./RemoteTerminalProtocolClient.js";
import { ThrottledTcpProxy } from "./testing/ThrottledTcpProxy.js";

const cleanups: (() => void | Promise<void>)[] = [];
const networkConditionTimeoutMs = 10_000;

afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("remote terminal client/server over a constrained network", () => {
    it("measures real Ghostty convergence, typing, CPU, memory, and wire use at 1 Mbps / 150 ms RTT", async () => {
        const canonical = await GhosttyTerminal.create(120, 40);
        const replica = await GhosttyTerminal.create(120, 40);
        cleanups.push(
            () => canonical.close(),
            () => replica.close(),
        );
        let inputReceivedAt = 0;
        let driver!: ReturnType<typeof createGhosttyRemoteTerminalServer>["driver"];
        const created = createGhosttyRemoteTerminalServer(canonical, {
            initialCols: 120,
            initialRows: 40,
            maxUnacknowledgedBytes: 1024 * 1024,
            onInput(data) {
                inputReceivedAt = performance.now();
                return driver.publishOutput(data);
            },
        });
        driver = created.driver;
        const protocol = created.protocol;
        const backend = createServer((socket) => protocol.attach(socket));
        const backendPort = await listen(backend);
        cleanups.push(() => closeServer(backend));
        const proxy = new ThrottledTcpProxy({
            bytesPerSecond: 125_000,
            jitterMs: 4,
            maxChunkBytes: 137,
            oneWayLatencyMs: 75,
            targetPort: backendPort,
        });
        const proxyPort = await proxy.listen();
        cleanups.push(() => proxy.close());

        const renderReadyTimes: number[] = [];
        const ghosttyReplica = new GhosttyRemoteTerminalReplica(replica);
        const connectedAt = performance.now();
        const client = new RemoteTerminalProtocolClient({
            capabilities: { grid: false, vt: true },
            clientId: "networked-ghostty",
            replica: {
                applyGrid: () => ghosttyReplica.applyGrid(),
                async applyVt(data) {
                    const started = performance.now();
                    await ghosttyReplica.applyVt(data);
                    await replica.snapshot();
                    renderReadyTimes.push(performance.now() - started);
                },
                resize: (cols, rows) => ghosttyReplica.resize(cols, rows),
            },
            stream: await connect(proxyPort),
        });
        await client.ready;
        const handshakeMs = performance.now() - connectedAt;

        const ttfbSamples: number[] = [];
        const inputToPtySamples: number[] = [];
        const inputToRenderSamples: number[] = [];
        for (const character of "abcde") {
            const outputBefore = client.appliedOutputOffset;
            const started = performance.now();
            inputReceivedAt = 0;
            client.writeInput(character);
            await vi.waitFor(() => expect(inputReceivedAt).toBeGreaterThan(0), {
                timeout: networkConditionTimeoutMs,
            });
            inputToPtySamples.push(inputReceivedAt - started);
            await vi.waitFor(() => expect(client.appliedOutputOffset).toBe(outputBefore + 1), {
                timeout: networkConditionTimeoutMs,
            });
            inputToRenderSamples.push(performance.now() - started);
            ttfbSamples.push(inputToRenderSamples.at(-1)! - renderReadyTimes.at(-1)!);
        }

        const rssBefore = process.memoryUsage().rss;
        const cpuBefore = process.cpuUsage();
        const denseReadySamples: number[] = [];
        let densePayloadBytes = 0;
        const wireBefore = protocol.metrics.wireBytes;
        for (let frame = 0; frame < 5; frame += 1) {
            const dense = denseAnsiFrame(frame);
            densePayloadBytes += dense.length;
            const started = performance.now();
            await driver.publishOutput(dense);
            await vi.waitFor(
                () =>
                    expect(client.appliedOutputOffset).toBeGreaterThanOrEqual(
                        5 + densePayloadBytes,
                    ),
                { timeout: networkConditionTimeoutMs },
            );
            denseReadySamples.push(performance.now() - started);
            const [serverScreen, clientScreen] = await Promise.all([
                canonical.snapshot(),
                replica.snapshot(),
            ]);
            expect(clientScreen.text).toBe(serverScreen.text);
            expect(clientScreen.cursor).toEqual(serverScreen.cursor);
        }
        const cpu = process.cpuUsage(cpuBefore);
        const rssGrowthBytes = Math.max(0, process.memoryUsage().rss - rssBefore);
        const denseWireBytes = protocol.metrics.wireBytes - wireBefore;
        const verboseSnapshotBytes = verboseGridBytes(120, 40) * 5;

        const measurements = {
            cpuMs: rounded((cpu.user + cpu.system) / 1_000),
            densePayloadBytes,
            denseReadyP50Ms: rounded(percentile(denseReadySamples, 0.5)),
            denseReadyP95Ms: rounded(percentile(denseReadySamples, 0.95)),
            denseWireBytes,
            handshakeMs: rounded(handshakeMs),
            inputToPtyP50Ms: rounded(percentile(inputToPtySamples, 0.5)),
            inputToPtyP95Ms: rounded(percentile(inputToPtySamples, 0.95)),
            inputToRenderP50Ms: rounded(percentile(inputToRenderSamples, 0.5)),
            inputToRenderP95Ms: rounded(percentile(inputToRenderSamples, 0.95)),
            renderReadyP95Ms: rounded(percentile(renderReadyTimes, 0.95)),
            rssGrowthBytes,
            ttfbP50Ms: rounded(percentile(ttfbSamples, 0.5)),
            ttfbP95Ms: rounded(percentile(ttfbSamples, 0.95)),
            verboseSnapshotBytes,
            wireReduction: rounded(verboseSnapshotBytes / denseWireBytes),
        };
        console.info(`Hybrid Ghostty client/server benchmark: ${JSON.stringify(measurements)}`);

        expect(handshakeMs).toBeGreaterThanOrEqual(100);
        expect(handshakeMs).toBeLessThan(2_000);
        expect(percentile(inputToPtySamples, 0.95)).toBeLessThan(1_000);
        expect(percentile(inputToRenderSamples, 0.95)).toBeLessThan(2_500);
        expect(percentile(denseReadySamples, 0.95)).toBeLessThan(3_000);
        expect(verboseSnapshotBytes / denseWireBytes).toBeGreaterThan(20);
        expect(rssGrowthBytes).toBeLessThan(256 * 1024 * 1024);
    }, 30_000);
});

function denseAnsiFrame(frame: number): Buffer {
    let value = "\x1b[2J\x1b[H";
    let random = 0x9e3779b9 ^ frame;
    for (let row = 0; row < 40; row += 1) {
        value += `\x1b[${row + 1};1H\x1b[3${row % 8}m`;
        for (let column = 0; column < 120; column += 1) {
            random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
            value += String.fromCharCode(33 + (random % 90));
        }
    }
    return Buffer.from(`${value}\x1b[0m`);
}

function verboseGridBytes(cols: number, rows: number): number {
    return Buffer.byteLength(
        JSON.stringify({
            palette: Array.from({ length: 256 }, (_, index) => ({
                blue: index,
                green: index,
                red: index,
            })),
            rows: Array.from({ length: rows }, (_, y) => ({
                cells: Array.from({ length: cols }, (_, x) => ({
                    style: {
                        background: null,
                        blink: false,
                        bold: false,
                        dim: false,
                        foreground: { index: y % 7, kind: "palette" },
                        invisible: false,
                        inverse: false,
                        italic: false,
                        overline: false,
                        strikethrough: false,
                        underline: "none",
                        underlineColor: null,
                    },
                    text: "x",
                    width: 1,
                    x,
                })),
                wrapped: false,
            })),
        }),
    );
}

function rounded(value: number): number {
    return Math.round(value * 100) / 100;
}

function percentile(values: readonly number[], fraction: number): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string")
                return reject(new Error("Missing server port."));
            resolve(address.port);
        });
    });
}

function connect(port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = new Socket();
        socket.once("error", reject);
        socket.connect(port, "127.0.0.1", () => {
            socket.off("error", reject);
            resolve(socket);
        });
    });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}
