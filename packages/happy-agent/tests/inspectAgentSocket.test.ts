import { HAPPY_AGENT_PROTOCOL_VERSION, type HealthResponse } from "@slopus/happy-agent-client";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
    happyAgentVersionFromPath,
    isHappyAgentProcess,
} from "../sources/lifecycle/describeLocalProcess.js";
import {
    inspectAgentSocket,
    judgeAgentSocketListener,
    type AgentSocketListener,
} from "../sources/lifecycle/inspectAgentSocket.js";

const SOCKET = "/Users/someone/.happy/agent/server.sock";
const SELF = { pid: 1000, uid: 501, platform: "darwin" as const };
const OLD_AGENT = "/Users/someone/.happy/dist/version/0.4.86/happy-agent";
const TOKEN = "a".repeat(43);

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

function happyAgent(overrides: Partial<AgentSocketListener> = {}): AgentSocketListener {
    return {
        pid: 4242,
        uid: 501,
        executable: OLD_AGENT,
        happyAgent: true,
        version: "0.4.86",
        ...overrides,
    };
}

/** A daemon socket in a fresh directory, answering health with this status and body. */
async function daemonSocket(answer?: { status: number; body: unknown }) {
    const directory = await mkdtemp(join(tmpdir(), "inspect-"));
    const paths = { socketPath: join(directory, "s.sock"), tokenPath: join(directory, "token") };
    let server: Server | undefined;
    if (answer !== undefined) {
        server = createServer((_request, response) => {
            response.writeHead(answer.status, { "content-type": "application/json" });
            response.end(JSON.stringify(answer.body));
        });
        await new Promise<void>((resolve) => server!.listen(paths.socketPath, resolve));
    }
    cleanups.push(async () => {
        await new Promise((resolve) =>
            server === undefined ? resolve(undefined) : server.close(resolve),
        );
        await rm(directory, { force: true, recursive: true });
    });
    return paths;
}

describe.skipIf(process.platform === "win32")("inspecting the daemon socket", () => {
    it("starts a daemon when nothing listens", async () => {
        const paths = await daemonSocket();
        await writeFile(paths.tokenPath, `${TOKEN}\n`);
        expect(await inspectAgentSocket(paths, SELF)).toEqual({ kind: "start" });
        await rm(paths.tokenPath);
        expect(await inspectAgentSocket(paths, SELF)).toEqual({ kind: "start" });
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
        expect(await inspectAgentSocket(paths, SELF)).toMatchObject({
            kind: "connect",
            health,
            token: TOKEN,
        });
    });

    it("judges a listener that rejects the token, or answers without one", async () => {
        const paths = await daemonSocket({
            status: 401,
            body: { error: "Unauthorized", code: "unauthorized" },
        });
        // Node cannot read peer credentials, so the listener stays unidentified and is left alone.
        const unidentified = {
            kind: "refuse",
            error: { exitCode: 69, message: expect.stringContaining("cannot authenticate") },
        };
        expect(await inspectAgentSocket(paths, SELF)).toMatchObject(unidentified);
        await writeFile(paths.tokenPath, `${TOKEN}\n`);
        expect(await inspectAgentSocket(paths, SELF)).toMatchObject(unidentified);
    });
});

describe("judging a listener this installation cannot authenticate with", () => {
    it("replaces this user's Happy Agent, with its supervisor", () => {
        expect(judgeAgentSocketListener(happyAgent(), SOCKET, SELF)).toEqual({
            kind: "replace",
            pid: 4242,
            version: "0.4.86",
        });
        expect(
            judgeAgentSocketListener(happyAgent({ supervisorPid: 4241 }), SOCKET, SELF),
        ).toMatchObject({ kind: "replace", supervisorPid: 4241 });
    });

    it("refuses at once, naming the process, when the listener is not Happy Agent", () => {
        const listener = { pid: 777, uid: 501, executable: "/usr/bin/python3", happyAgent: false };
        expect(judgeAgentSocketListener(listener, SOCKET, SELF)).toMatchObject({
            kind: "refuse",
            error: {
                message: `Process 777 (/usr/bin/python3) is serving ${SOCKET}, and it is not Happy Agent.`,
                hint: "It was left running. Stop it, then try again.",
                exitCode: 69,
            },
        });
    });

    it("refuses another user's Happy Agent", () => {
        expect(judgeAgentSocketListener(happyAgent({ uid: 502 }), SOCKET, SELF)).toMatchObject({
            kind: "refuse",
            error: { message: `Process 4242, owned by another user, is serving ${SOCKET}.` },
        });
    });

    it("refuses a listener it cannot identify, and never the process asking", () => {
        expect(judgeAgentSocketListener({ happyAgent: false }, SOCKET, SELF)).toMatchObject({
            kind: "refuse",
            error: {
                hint: "Its process could not be identified, so it was left running. Stop it, then try again.",
            },
        });
        expect(
            judgeAgentSocketListener({ happyAgent: false }, SOCKET, { ...SELF, platform: "win32" }),
        ).toMatchObject({
            error: { hint: "Quit every other Happy Agent and Happy app, then try again." },
        });
        expect(judgeAgentSocketListener(happyAgent({ pid: SELF.pid }), SOCKET, SELF).kind).toBe(
            "refuse",
        );
    });
});

describe("recognizing a Happy Agent process", () => {
    it.each([
        [OLD_AGENT, `${OLD_AGENT} run`],
        ["/opt/happy/happy-agent-linux-x64", "/opt/happy/happy-agent-linux-x64 run"],
        ["C:\\Happy\\happy-agent.exe", "C:\\Happy\\happy-agent.exe run"],
        ["/opt/homebrew/bin/node", "node /src/packages/happy-agent/dist/cli.js run"],
        ["/Users/someone/.bun/bin/bun", "bun /src/packages/happy-agent/sources/cli.ts run"],
    ])("recognizes %s", (executable, commandLine) => {
        expect(isHappyAgentProcess({ executable, commandLine })).toBe(true);
    });

    it.each([
        ["/usr/bin/python3", "python3 -m http.server"],
        ["/opt/homebrew/bin/node", "node /src/packages/happy-agent-gym/dist/cli.js run"],
        ["/opt/homebrew/bin/node", "node /src/server.js --name happy-agent"],
        ["/Applications/Happy.app/Contents/MacOS/Happy", "Happy"],
    ])("does not recognize %s", (executable, commandLine) => {
        expect(isHappyAgentProcess({ executable, commandLine })).toBe(false);
    });

    it("reads an installed release's version from its path only", () => {
        expect(happyAgentVersionFromPath(OLD_AGENT)).toBe("0.4.86");
        expect(
            happyAgentVersionFromPath(
                "C:\\Users\\x\\.happy\\dist\\version\\0.4.90\\happy-agent.exe",
            ),
        ).toBe("0.4.90");
        expect(happyAgentVersionFromPath("/opt/happy/happy-agent")).toBeUndefined();
        expect(happyAgentVersionFromPath("/x/dist/version/1.0.0/node")).toBeUndefined();
    });
});
