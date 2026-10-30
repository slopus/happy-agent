import type { HappyAgentClient, HealthResponse } from "@slopus/happy-agent-client";
import { describe, expect, it } from "vitest";

import { AgentDaemonError } from "../sources/lifecycle/AgentDaemonError.js";
import { decideAgentSocketAction } from "../sources/lifecycle/decideAgentSocketAction.js";
import { isHappyAgentProcess } from "../sources/lifecycle/describeLocalProcess.js";
import type {
    AgentSocketListener,
    AgentSocketListenerIdentity,
} from "../sources/lifecycle/inspectAgentSocket.js";

const SOCKET = "/Users/someone/.happy/agent/server.sock";
const SELF = { pid: 1000, uid: 501, platform: "darwin" as const };
const OLD_AGENT = "/Users/someone/.happy/dist/version/0.4.86/happy-agent";

function unauthenticated(
    identity: AgentSocketListenerIdentity,
    reason: "missing-token" | "rejected-token" = "rejected-token",
): AgentSocketListener {
    return { kind: "unauthenticated", reason, identity };
}

function happyAgent(overrides: Partial<AgentSocketListenerIdentity> = {}) {
    return {
        pid: 4242,
        uid: 501,
        happyAgent: true,
        version: "0.4.86",
        process: {
            pid: 4242,
            parentPid: 1,
            uid: 501,
            executable: OLD_AGENT,
            commandLine: `${OLD_AGENT} run`,
        },
        ...overrides,
    } satisfies AgentSocketListenerIdentity;
}

describe("what start does about the daemon socket", () => {
    it("starts a daemon when nothing listens", () => {
        expect(decideAgentSocketAction({ kind: "none" }, SOCKET, SELF)).toEqual({ kind: "start" });
    });

    it("keeps the version-match path for a daemon that accepts the token", () => {
        const listener: AgentSocketListener = {
            kind: "authenticated",
            client: {} as HappyAgentClient,
            health: {} as HealthResponse,
            token: "token",
        };
        expect(decideAgentSocketAction(listener, SOCKET, SELF)).toEqual({ kind: "connect" });
    });

    it("leaves a listener that answers health with something other than a refusal to start", () => {
        expect(decideAgentSocketAction({ kind: "unresponsive" }, SOCKET, SELF)).toEqual({
            kind: "start",
        });
    });

    it("replaces this user's Happy Agent that rejects the token", () => {
        expect(decideAgentSocketAction(unauthenticated(happyAgent()), SOCKET, SELF)).toEqual({
            kind: "replace",
            pid: 4242,
            version: "0.4.86",
        });
    });

    it("replaces this user's Happy Agent when the token file is gone, with its supervisor", () => {
        const listener = unauthenticated(happyAgent({ supervisorPid: 4241 }), "missing-token");
        expect(decideAgentSocketAction(listener, SOCKET, SELF)).toEqual({
            kind: "replace",
            pid: 4242,
            supervisorPid: 4241,
            version: "0.4.86",
        });
    });

    it("refuses at once, naming the process, when the listener is not Happy Agent", () => {
        const listener = unauthenticated({
            pid: 777,
            uid: 501,
            happyAgent: false,
            process: {
                pid: 777,
                parentPid: 1,
                uid: 501,
                executable: "/usr/local/bin/python3",
                commandLine: "python3 -m http.server",
            },
        });
        const action = decideAgentSocketAction(listener, SOCKET, SELF);
        expect(action.kind).toBe("refuse");
        if (action.kind !== "refuse") return;
        expect(action.error).toBeInstanceOf(AgentDaemonError);
        expect(action.error).toMatchObject({
            message: `Process 777 (/usr/local/bin/python3) is serving ${SOCKET}, and it is not Happy Agent.`,
            hint: "It was left running. Stop it, then try again.",
            exitCode: 69,
        });
    });

    it("refuses a Happy Agent that belongs to another user", () => {
        const action = decideAgentSocketAction(
            unauthenticated(happyAgent({ uid: 502 })),
            SOCKET,
            SELF,
        );
        expect(action).toMatchObject({
            kind: "refuse",
            error: { message: `Process 4242, owned by another user, is serving ${SOCKET}.` },
        });
    });

    it("refuses a listener whose process cannot be identified", () => {
        const action = decideAgentSocketAction(
            unauthenticated({ happyAgent: false }),
            SOCKET,
            SELF,
        );
        expect(action).toMatchObject({
            kind: "refuse",
            error: {
                message: `Another process is serving ${SOCKET}, and this installation cannot authenticate with it.`,
                hint: "Its process could not be identified, so it was left running. Stop it, then try again.",
                exitCode: 69,
            },
        });
        const onWindows = decideAgentSocketAction(unauthenticated({ happyAgent: false }), SOCKET, {
            ...SELF,
            platform: "win32",
        });
        expect(onWindows).toMatchObject({
            error: { hint: "Quit every other Happy Agent and Happy app, then try again." },
        });
    });

    it("never stops the process asking", () => {
        const action = decideAgentSocketAction(
            unauthenticated(happyAgent({ pid: SELF.pid })),
            SOCKET,
            SELF,
        );
        expect(action.kind).toBe("refuse");
    });
});

describe("recognizing a Happy Agent process", () => {
    it.each([
        [OLD_AGENT, `${OLD_AGENT} run`],
        ["/opt/happy/happy-agent-darwin-arm64", "/opt/happy/happy-agent-darwin-arm64 run"],
        ["C:\\Happy\\happy-agent.exe", "C:\\Happy\\happy-agent.exe run"],
        ["/opt/homebrew/bin/node", "node /src/packages/happy-agent/dist/cli.js run"],
        ["/Users/someone/.bun/bin/bun", "bun /src/packages/happy-agent/sources/cli.ts run"],
        [
            "/usr/bin/node",
            "node /home/someone/.npm/node_modules/@slopus/happy-agent/dist/cli.js run",
        ],
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
});
