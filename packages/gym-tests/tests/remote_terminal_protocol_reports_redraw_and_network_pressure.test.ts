import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("remote terminal protocol performance", () => {
    it("reports hybrid redraw, typing, slow-reader, reconnect, resize, and scrollback measurements", async () => {
        const gym = await createGym({
            mode: "docker",
            files: {
                "remote-terminal-load.mjs": REMOTE_TERMINAL_LOAD,
                "remote-terminal-benchmark.mjs": REMOTE_TERMINAL_BENCHMARK,
            },
        });
        running.add(gym);

        const { stdout } = await gym.runInContainer("node", ["remote-terminal-benchmark.mjs"], {
            timeoutMs: 120_000,
        });
        const result = JSON.parse(stdout) as BenchmarkResult;

        console.info(`Remote terminal benchmark: ${JSON.stringify(result.metrics, null, 2)}`);

        expect(result.correctness).toMatchObject({
            denseRendered: true,
            reconnectConverged: true,
            resized: true,
            slowReaderConverged: true,
            stormTypingRendered: true,
        });
        expect(result.metrics.stream.timeToFirstByteMs).toBeLessThan(1_000);
        expect(result.metrics.stream.timeToFirstRenderMs).toBeLessThan(2_000);
        expect(result.metrics.redraw.denseWireBytes).toBeGreaterThan(
            result.metrics.redraw.sparseWireBytes,
        );
        expect(result.metrics.redraw.denseWireBytes).toBeLessThan(100_000);
        expect(result.metrics.redraw.typingLatencyP95Ms).toBeLessThan(1_000);
        expect(result.metrics.pressure.slowVtApplications).toBeLessThan(
            result.metrics.pressure.redraws,
        );
        expect(result.metrics.pressure.slowReaderConvergenceMs).toBeLessThan(5_000);
        expect(result.metrics.reconnect.catchupMs).toBeLessThan(2_000);
        expect(result.metrics.scrollback.totalRows).toBeGreaterThanOrEqual(500);
        expect(result.metrics.scrollback.fetch500RowsMs).toBeLessThan(2_000);
    }, 180_000);
});

interface BenchmarkResult {
    correctness: {
        denseRendered: boolean;
        reconnectConverged: boolean;
        resized: boolean;
        slowReaderConverged: boolean;
        stormTypingRendered: boolean;
    };
    metrics: {
        pressure: {
            redraws: number;
            slowReaderConvergenceMs: number;
            slowVtApplications: number;
            stormTypingLatencyMs: number;
        };
        reconnect: { catchupMs: number };
        redraw: {
            densePayloadBytes: number;
            denseWireBytes: number;
            sparseWireBytes: number;
            typingLatencyP50Ms: number;
            typingLatencyP95Ms: number;
            wireReduction: number;
        };
        scrollback: {
            fetch500RowsMs: number;
            returnedRows: number;
            totalRows: number;
        };
        stream: { timeToFirstByteMs: number; timeToFirstRenderMs: number };
    };
}

const REMOTE_TERMINAL_LOAD = String.raw`
import { createInterface } from "node:readline";

const COLS = 120;
const ROWS = 40;
let typedMarker = "";

function title(value) {
    return "\u001b]0;" + value + "\u0007";
}

function dense(marker) {
    let output = title(marker) + "\u001b[2J";
    for (let row = 0; row < ROWS; row += 1) {
        const prefix = row === 0 ? marker : row === 1 ? typedMarker : "row-" + row;
        const fill = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(4);
        const text = (prefix + " " + fill).slice(0, COLS).padEnd(COLS, "x");
        output += "\u001b[" + (31 + (row % 7)) + "m\u001b[" + (row + 1) + ";1H" + text;
    }
    output += "\u001b[0m";
    process.stdout.write(output);
    return Buffer.byteLength(output);
}

function sparse(marker) {
    const output = title(marker) + "\u001b[2J\u001b[H" + marker;
    process.stdout.write(output);
    return Buffer.byteLength(output);
}

function storm(count) {
    let index = 0;
    const draw = () => {
        if (index >= count) {
            dense("STORM-DONE");
            return;
        }
        dense("STORM-" + index);
        index += 1;
        setImmediate(draw);
    };
    setImmediate(draw);
}

function history(count) {
    let output = "\u001b[2J\u001b[H";
    for (let index = 0; index < count; index += 1) {
        output += "history-" + String(index).padStart(5, "0") + "\r\n";
    }
    output += title("HISTORY-DONE") + "HISTORY-DONE";
    process.stdout.write(output);
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
    const separator = line.indexOf(":");
    const operation = separator < 0 ? line : line.slice(0, separator);
    const argument = separator < 0 ? "" : line.slice(separator + 1);
    if (operation === "dense") dense(argument);
    else if (operation === "sparse") sparse(argument);
    else if (operation === "storm") storm(Number(argument));
    else if (operation === "type") {
        typedMarker = "TYPE-" + argument;
        dense(typedMarker);
    } else if (operation === "history") history(Number(argument));
    else if (operation === "exit") process.exit(0);
});

sparse("READY");
`;

const REMOTE_TERMINAL_BENCHMARK = String.raw`
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { performance } from "node:perf_hooks";
import { createGhosttyTerminal } from "/app/packages/happy-terminal/node_modules/@slopus/ghostty-wasm/dist/node.js";
import {
    GhosttyRemoteTerminalReplica,
    RemoteTerminalProtocolClient,
} from "/app/packages/happy-terminal/node_modules/@slopus/ghostty-web/dist/index.js";
import WebSocket from "/app/packages/happy-terminal/node_modules/ws/wrapper.mjs";
import { WebSocketDuplex, createNodeBinaryWebSocket } from "/app/packages/happy-terminal/node_modules/@slopus/happy-agent-modules/dist/transport/index.js";

const directory = "/tmp/rig-" + process.getuid();
const socketPath = directory + "/server.sock";
const token = (await readFile(directory + "/token", "utf8")).trim();

function requestJson(method, path, body) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = request({
            socketPath,
            method,
            path,
            headers: {
                authorization: "Bearer " + token,
                accept: "application/json",
                ...(payload === undefined ? {} : {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(payload),
                }),
            },
        }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.on("end", () => {
                const bytes = Buffer.concat(chunks);
                if ((response.statusCode ?? 500) >= 400) {
                    reject(new Error(method + " " + path + ": " + bytes.toString("utf8")));
                    return;
                }
                resolve(bytes.length === 0 ? {} : JSON.parse(bytes.toString("utf8")));
            });
        });
        req.on("error", reject);
        if (payload !== undefined) req.write(payload);
        req.end();
    });
}

function openWebSocket(path) {
    const started = performance.now();
    return new Promise((resolve, reject) => {
        const webSocket = new WebSocket("ws+unix://" + socketPath + ":" + path, {
            headers: { authorization: "Bearer " + token },
            perMessageDeflate: false,
        });
        let firstMessageAt;
        let wireBytes = 0;
        webSocket.on("message", (data) => {
            wireBytes += Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
            firstMessageAt ??= performance.now();
        });
        webSocket.once("error", reject);
        webSocket.once("open", () => resolve({
            firstByteMs: () => (firstMessageAt ?? performance.now()) - started,
            started,
            webSocket,
            wireBytes: () => wireBytes,
        }));
    });
}

async function createReplica() {
    const terminal = await createGhosttyTerminal({ cols: 120, rows: 40, maxScrollback: 10_000 });
    const vt = new GhosttyRemoteTerminalReplica({
        resize: (cols, rows) => terminal.resize(cols, rows),
        snapshot() { throw new Error("not used"); },
        writeBytes: (data) => terminal.write(data),
    });
    let gate = Promise.resolve();
    let releaseGate = () => {};
    const state = {
        grid: undefined,
        terminal,
        vtApplications: 0,
        block() {
            gate = new Promise((resolve) => { releaseGate = resolve; });
        },
        release() {
            releaseGate();
            gate = Promise.resolve();
        },
        replica: {
            applyGrid(grid) { state.grid = grid; },
            async applyVt(data) {
                state.vtApplications += 1;
                await gate;
                state.grid = undefined;
                await vt.applyVt(data);
            },
            resize: (cols, rows) => vt.resize(cols, rows),
        },
    };
    return state;
}

async function attach(path, clientId, options = {}) {
    const replicaState = options.replicaState ?? await createReplica();
    const connection = await openWebSocket(path);
    const stream = new WebSocketDuplex(createNodeBinaryWebSocket(connection.webSocket));
    let resolveExit;
    const exited = new Promise((resolve) => { resolveExit = resolve; });
    const reconnect = options.reconnect;
    const protocol = new RemoteTerminalProtocolClient({
        capabilities: { grid: true, vt: true },
        clientId,
        creditBytes: options.creditBytes ?? 256 * 1024,
        ...(reconnect?.epoch === undefined ? {} : { epoch: reconnect.epoch }),
        ...(reconnect?.inputLease === undefined ? {} : { inputLease: reconnect.inputLease }),
        ...(reconnect === undefined ? {} : {
            pendingInputs: reconnect.pendingInputs,
            resumeInputSequence: reconnect.resumeInputSequence,
            resumeOutputOffset: reconnect.resumeOutputOffset,
        }),
        onExit: resolveExit,
        replica: replicaState.replica,
        stream,
    });
    const closed = new Promise((resolve) => connection.webSocket.once("close", resolve));
    await protocol.ready;
    return { closed, connection, exited, protocol, replicaState };
}

async function waitForDisplayTitle(attachment, title, timeoutMs = 30_000) {
    const started = performance.now();
    for (;;) {
        const currentTitle = attachment.replicaState.grid?.title ?? attachment.replicaState.terminal.snapshot().title;
        if (currentTitle === title) return;
        if (performance.now() - started >= timeoutMs) throw new Error("Timed out waiting for " + title);
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}

function percentile(values, fraction) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function rounded(value) {
    return Math.round(value * 100) / 100;
}

const projects = await requestJson("GET", "/v0/projects");
const project = projects.projects[0];
if (project === undefined) throw new Error("The daemon did not expose a project root workspace.");
const workspaceId = project.id;
const terminalPath = "/v0/workspaces/" + encodeURIComponent(workspaceId) + "/terminals";
const created = await requestJson("POST", terminalPath, {
    cols: 120,
    rows: 40,
    maxScrollback: 10_000,
    command: "stty -echo; exec node /workspace/remote-terminal-load.mjs",
});
const itemPath = terminalPath + "/" + encodeURIComponent(created.terminal.id);
const attachPath = itemPath + "/attach";

let fast = await attach(attachPath, "fast");
await waitForDisplayTitle(fast, "READY");
const firstRenderMs = performance.now() - fast.connection.started;
const firstByteMs = fast.connection.firstByteMs();

const latencies = [];
const sparseWireBefore = fast.connection.wireBytes();
let started = performance.now();
fast.protocol.writeInput("sparse:SPARSE-BENCH\n");
await waitForDisplayTitle(fast, "SPARSE-BENCH");
latencies.push(performance.now() - started);
const sparseWireBytes = fast.connection.wireBytes() - sparseWireBefore;

const denseWireBefore = fast.connection.wireBytes();
for (let index = 0; index < 5; index += 1) {
    started = performance.now();
    fast.protocol.writeInput("dense:DENSE-BENCH-" + index + "\n");
    await waitForDisplayTitle(fast, "DENSE-BENCH-" + index);
    latencies.push(performance.now() - started);
}
const denseWireBytes = fast.connection.wireBytes() - denseWireBefore;
const densePayloadBytes = 120 * 40 * 5;
const denseRendered = fast.replicaState.terminal.snapshot().title === "DENSE-BENCH-4";

const stormStarted = performance.now();
fast.protocol.writeInput("storm:8\n");
fast.protocol.writeInput("type:urgent\n");
await waitForDisplayTitle(fast, "STORM-DONE");
const stormSnapshot = fast.replicaState.terminal.snapshot();
const stormTypingLatencyMs = performance.now() - stormStarted;
const stormTypingRendered = stormSnapshot.rows.some((row) => row.cells.map((cell) => cell.text).join("").includes("TYPE-urgent"));

const slow = await attach(attachPath, "slow", { creditBytes: 16 * 1024 });
await waitForDisplayTitle(slow, "STORM-DONE");
const vtBefore = slow.replicaState.vtApplications;
slow.replicaState.block();
const pressureRedraws = 12;
for (let index = 0; index < pressureRedraws; index += 1) {
    fast.protocol.writeInput("dense:PRESSURE-" + index + "\n");
}
await waitForDisplayTitle(fast, "PRESSURE-11");
const resumeStarted = performance.now();
slow.replicaState.release();
await waitForDisplayTitle(slow, "PRESSURE-11");
const slowReaderConvergenceMs = performance.now() - resumeStarted;
const slowVtApplications = slow.replicaState.vtApplications - vtBefore;

const reconnectState = fast.protocol.reconnectState();
const fastReplica = fast.replicaState;
fast.protocol.close();
await fast.closed;
slow.protocol.writeInput("dense:RECONNECT\n");
await waitForDisplayTitle(slow, "RECONNECT");
const reconnectStarted = performance.now();
fast = await attach(attachPath, "fast", { reconnect: reconnectState, replicaState: fastReplica });
await waitForDisplayTitle(fast, "RECONNECT");
const reconnectCatchupMs = performance.now() - reconnectStarted;

await requestJson("PATCH", itemPath, { cols: 100, rows: 30 });
for (;;) {
    const snapshot = fast.replicaState.terminal.snapshot();
    if (snapshot.cols === 100 && snapshot.visibleRows === 30) break;
    await new Promise((resolve) => setTimeout(resolve, 2));
}
const resized = fast.replicaState.terminal.snapshot().cols === 100;

fast.protocol.writeInput("history:5000\n");
await waitForDisplayTitle(fast, "HISTORY-DONE", 60_000);
const historySnapshot = fast.replicaState.terminal.snapshot();
const scrollStart = Math.max(0, historySnapshot.totalRows - 500);
const scrollStarted = performance.now();
const page = await fast.protocol.requestScrollback(scrollStart, 500);
const fetch500RowsMs = performance.now() - scrollStarted;

fast.protocol.writeInput("exit\n");
await fast.exited;
const terminals = await requestJson("GET", terminalPath);

process.stdout.write(JSON.stringify({
    correctness: {
        denseRendered,
        reconnectConverged: fast.replicaState.terminal.snapshot().title === "HISTORY-DONE",
        resized,
        slowReaderConverged: slow.replicaState.grid?.title === "HISTORY-DONE" || slow.replicaState.grid?.title === "RECONNECT",
        stormTypingRendered,
    },
    metrics: {
        pressure: {
            redraws: pressureRedraws,
            slowReaderConvergenceMs: rounded(slowReaderConvergenceMs),
            slowVtApplications,
            stormTypingLatencyMs: rounded(stormTypingLatencyMs),
        },
        reconnect: { catchupMs: rounded(reconnectCatchupMs) },
        redraw: {
            densePayloadBytes,
            denseWireBytes,
            sparseWireBytes,
            typingLatencyP50Ms: rounded(percentile(latencies, 0.5)),
            typingLatencyP95Ms: rounded(percentile(latencies, 0.95)),
            wireReduction: rounded(densePayloadBytes / denseWireBytes),
        },
        scrollback: {
            fetch500RowsMs: rounded(fetch500RowsMs),
            returnedRows: page.rows.length,
            totalRows: page.totalRows,
        },
        stream: {
            timeToFirstByteMs: rounded(firstByteMs),
            timeToFirstRenderMs: rounded(firstRenderMs),
        },
    },
    status: terminals.terminals.find((terminal) => terminal.id === created.terminal.id)?.status,
}));
fast.protocol.close();
slow.protocol.close();
fast.replicaState.terminal.dispose();
slow.replicaState.terminal.dispose();
`;
