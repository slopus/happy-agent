import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("remote terminal API", () => {
    it("replays a real PTY through the hybrid WebSocket protocol and pages scrollback", async () => {
        const gym = await createGym({
            mode: "docker",
            files: { "remote-terminal-client.mjs": REMOTE_TERMINAL_CLIENT },
        });
        running.add(gym);

        const { stdout } = await gym.runInContainer("node", ["remote-terminal-client.mjs"], {
            timeoutMs: 60_000,
        });
        const result = JSON.parse(stdout) as {
            finalStatus: string;
            greenStyled: boolean;
            mode: string;
            outputOffset: number;
            text: string;
            totalRows: number;
        };

        expect(result.finalStatus).toBe("exited");
        expect(result.greenStyled).toBe(true);
        expect(result.mode).toBe("vt");
        expect(result.outputOffset).toBeGreaterThan(0);
        expect(result.text).toContain("reply:hello");
        expect(result.text).toContain("history-4");
        expect(result.totalRows).toBeGreaterThan(3);
    }, 120_000);
});

const REMOTE_TERMINAL_CLIENT = String.raw`
import { readFile } from "node:fs/promises";
import { request } from "node:http";
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
                const text = Buffer.concat(chunks).toString("utf8");
                if ((response.statusCode ?? 500) >= 400) {
                    reject(new Error(text));
                    return;
                }
                resolve(text.length === 0 ? {} : JSON.parse(text));
            });
        });
        req.on("error", reject);
        if (payload !== undefined) req.write(payload);
        req.end();
    });
}

function openWebSocket(path) {
    return new Promise((resolve, reject) => {
        const webSocket = new WebSocket("ws+unix://" + socketPath + ":" + path, {
            headers: { authorization: "Bearer " + token },
            perMessageDeflate: false,
        });
        webSocket.once("error", reject);
        webSocket.once("open", () => resolve(webSocket));
    });
}

function rowText(row) {
    const cells = Array.from({ length: 200 }, () => " ");
    let width = 0;
    for (const cell of row.cells) {
        cells[cell.x] = cell.text;
        width = Math.max(width, cell.x + cell.width);
    }
    return cells.slice(0, width).join("").trimEnd();
}

const projects = await requestJson("GET", "/v0/projects");
const project = projects.projects[0];
if (project === undefined) throw new Error("The daemon did not expose a project root workspace.");
const workspaceId = project.id;
const terminalPath = "/v0/workspaces/" + encodeURIComponent(workspaceId) + "/terminals";
const created = await requestJson("POST", terminalPath, {
    cols: 30,
    rows: 3,
    command: "printf '\\033[32mhistory-1\\033[0m\\nhistory-2\\nhistory-3\\nhistory-4\\n'; IFS= read -r value; printf 'reply:%s\\n' \"$value\"",
});
const attachPath = terminalPath + "/" + encodeURIComponent(created.terminal.id) + "/attach";
const terminal = await createGhosttyTerminal({ cols: 30, rows: 3, maxScrollback: 10_000 });
const vtReplica = new GhosttyRemoteTerminalReplica({
    resize: (cols, rows) => terminal.resize(cols, rows),
    snapshot() { throw new Error("not used"); },
    writeBytes: (data) => terminal.write(data),
});
const webSocket = await openWebSocket(attachPath);
const stream = new WebSocketDuplex(createNodeBinaryWebSocket(webSocket));
let resolveExit;
const exited = new Promise((resolve) => { resolveExit = resolve; });
const protocol = new RemoteTerminalProtocolClient({
    capabilities: { grid: false, vt: true },
    clientId: "gym-client",
    onExit: resolveExit,
    replica: vtReplica,
    stream,
});
await protocol.ready;
protocol.writeInput("hello\n");
await exited;
const page = await protocol.requestScrollback(0, 20);
const status = await requestJson("GET", terminalPath);
const styles = page.styles ?? protocol.grid?.styles ?? [];
const greenStyled = page.rows.some((row) => row.cells.some((cell) => {
    const foreground = styles[cell.styleId]?.foreground;
    return cell.text === "h" && foreground?.kind === "palette" && foreground.index === 2;
}));
process.stdout.write(JSON.stringify({
    finalStatus: status.terminals.find((item) => item.id === created.terminal.id)?.status,
    greenStyled,
    mode: protocol.mode,
    outputOffset: protocol.appliedOutputOffset,
    text: page.rows.map(rowText).join("\n"),
    totalRows: page.totalRows,
}));
protocol.close();
terminal.dispose();
`;
