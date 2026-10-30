import { HAPPY_AGENT_PROTOCOL_VERSION, type HealthResponse } from "@slopus/happy-agent-client";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isHappyAgentProcess } from "../sources/lifecycle/readSocketPeer.js";
import {
    inspectAgentSocket,
    judgeAgentSocketListener,
} from "../sources/lifecycle/inspectAgentSocket.js";

const SOCKET = "/Users/someone/.happy/agent/server.sock";
const SELF = { pid: 1000, uid: 501 };
const OLD_AGENT = "/Users/someone/.happy/dist/version/0.4.86/happy-agent";
const TOKEN = "a".repeat(43);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function daemonSocket(answer?: { status: number; body: unknown }) {
    const directory = await mkdtemp(join(tmpdir(), "inspect-"));
    const paths = { socketPath: join(directory, "s.sock"), tokenPath: join(directory, "token") };
    let server: Server | undefined;
    if (answer) {
        server = createServer((_request, response) => {
            response.writeHead(answer.status, { "content-type": "application/json" });
            response.end(JSON.stringify(answer.body));
        });
        await new Promise<void>((resolve) => server!.listen(paths.socketPath, resolve));
    }
    cleanups.push(async () => {
        if (server) await new Promise((resolve) => server!.close(resolve));
        await rm(directory, { force: true, recursive: true });
    });
    return paths;
}

describe.skipIf(process.platform === "win32")("inspecting the daemon socket", () => {
    it("starts a daemon when nothing listens", async () => {
        const paths = await daemonSocket();
        await writeFile(paths.tokenPath, `${TOKEN}\n`);
        expect(await inspectAgentSocket(paths)).toEqual({ kind: "start" });
        await rm(paths.tokenPath);
        expect(await inspectAgentSocket(paths)).toEqual({ kind: "start" });
    });
    it("connects to a daemon that accepts the token", async () => {
        const health: HealthResponse = {
            healthy: true,
            ready: true,
            draining: false,
            drainWaitingFor: [],
            shuttingDown: false,
            status: "ready",
            version: { protocol: HAPPY_AGENT_PROTOCOL_VERSION, daemon: "test" },
            waitingFor: [],
        };
        const paths = await daemonSocket({ status: 200, body: health });
        await writeFile(paths.tokenPath, `${TOKEN}\n`);
        expect(await inspectAgentSocket(paths)).toMatchObject({
            kind: "connect",
            health,
            token: TOKEN,
        });
    });
    it("leaves an unidentified listener running with or without a token", async () => {
        const paths = await daemonSocket({
            status: 401,
            body: { error: "Unauthorized", code: "unauthorized" },
        });
        await expect(inspectAgentSocket(paths)).rejects.toMatchObject({ exitCode: 69 });
        await writeFile(paths.tokenPath, `${TOKEN}\n`);
        await expect(inspectAgentSocket(paths)).rejects.toMatchObject({ exitCode: 69 });
    });
});

describe("judging an unreachable listener", () => {
    const listener = { pid: 4242, uid: 501, executable: OLD_AGENT };
    it("accepts this user's standalone Happy Agent", () => {
        expect(() => judgeAgentSocketListener(listener, SOCKET, SELF)).not.toThrow();
    });
    it.each([
        [{ ...listener, executable: "/usr/bin/python3" }, "not Happy Agent"],
        [{ ...listener, executable: "/usr/bin/node" }, "not Happy Agent"],
        [{ ...listener, uid: 502 }, "owned by another user"],
        [{ ...listener, uid: undefined }, "owned by another user"],
        [{ ...listener, executable: undefined }, "not Happy Agent"],
        [{ ...listener, pid: SELF.pid }, "cannot authenticate"],
        [{}, "cannot authenticate"],
    ])("refuses %j", (candidate, message) => {
        expect(() => judgeAgentSocketListener(candidate, SOCKET, SELF)).toThrow(message);
        try {
            judgeAgentSocketListener(candidate, SOCKET, SELF);
        } catch (error) {
            expect(error).toMatchObject({ exitCode: 69 });
        }
    });
});

describe("recognizing a standalone Happy Agent", () => {
    it.each([OLD_AGENT, "/opt/happy/happy-agent-linux-x64", "C:\\Happy\\happy-agent.exe"])(
        "recognizes %s",
        (executable) => {
            expect(isHappyAgentProcess({ executable })).toBe(true);
        },
    );
    it.each([
        "/usr/bin/python3",
        "/opt/homebrew/bin/node",
        "/Users/someone/.bun/bin/bun",
        "/Applications/Happy.app/Contents/MacOS/Happy",
    ])("does not recognize %s", (executable) => {
        expect(isHappyAgentProcess({ executable })).toBe(false);
    });
});
