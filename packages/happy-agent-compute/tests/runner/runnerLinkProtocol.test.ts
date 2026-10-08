import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import type { ComputeSessionExit } from "../../sources/ComputeShell.js";
import { computePermissions } from "../../sources/ComputePermissions.js";
import {
    decodeRunnerFrame,
    encodeRunnerFrame,
} from "../../sources/runner/impl/runnerFrameCodec.js";
import {
    createRunnerChannelPair,
    createRunnerCompute,
    RunnerLink,
    type RunnerChannel,
    type RunnerFrameHeader,
} from "../../sources/runner/index.js";

const ctx: Context = createRootContext().named("runner-link-protocol-test");
const links: RunnerLink[] = [];
const identity = {
    version: "test",
    platform: "linux",
    arch: "x64",
    hostname: "fake",
    home: "/home/runner",
};

afterEach(() => {
    for (const link of links.splice(0)) link.close("The test finished.");
});

/**
 * A runner may be a compromised machine. These tests drive the daemon's side with a hand-written
 * runner that misbehaves, to prove the daemon refuses what the protocol does not allow.
 */
describe("the daemon's side of a runner connection", () => {
    it("refuses a runner that shares no protocol version", async () => {
        const runner = fakeRunner();
        const accepting = link().accept(runner.daemonEnd);

        runner.send({
            type: "hello",
            protocol: { min: 90, max: 99 },
            runner: identity,
        });

        await expect(accepting).rejects.toMatchObject({ code: "ERUNNERINCOMPATIBLE" });
        expect(runner.received.at(-1)).toMatchObject({ type: "goodbye" });
    });

    it("rejects a result that does not match the protocol", async () => {
        const runner = fakeRunner();
        const daemon = link();
        const accepted = daemon.accept(runner.daemonEnd);
        await runner.handshake();
        await accepted;
        runner.answer((request) =>
            request.method === "compute.create"
                ? { cwd: "/work", kind: "host", supportsSessionInput: true, retained: false }
                : { exists: "yes" },
        );
        const compute = await createRunnerCompute(ctx, {
            link: daemon,
            computeId: "agent-1",
            cwd: "/work",
        });

        await expect(compute.fs.exists(computePermissions("read_only"), "x")).rejects.toMatchObject(
            {
                code: "ERUNNERPROTOCOL",
            },
        );
    });

    it("drops a runner that sends a malformed frame", async () => {
        const runner = fakeRunner();
        const daemon = link();
        const accepted = daemon.accept(runner.daemonEnd);
        await runner.handshake();
        await accepted;

        runner.runnerEnd.send(new TextEncoder().encode("not a frame"));

        await waitFor(() => daemon.status().state === "disconnected");
        expect(daemon.status().reason).toBe(
            "The other side sent a frame whose header was cut short.",
        );
    });

    it("delivers a replayed exit event once, and acknowledges it again", async () => {
        const runner = fakeRunner();
        const daemon = link();
        const accepted = daemon.accept(runner.daemonEnd);
        await runner.handshake();
        await accepted;
        runner.answer(() => ({
            cwd: "/work",
            kind: "host",
            supportsSessionInput: true,
            retained: false,
        }));
        const compute = await createRunnerCompute(ctx, {
            link: daemon,
            computeId: "agent-1",
            cwd: "/work",
        });
        const exits: ComputeSessionExit[] = [];
        compute.shell.setSessionExitListener?.((exit) => {
            exits.push(exit);
        });
        const exit: RunnerFrameHeader = {
            type: "event",
            seq: 1,
            event: "shell.exit",
            params: {
                computeId: "agent-1",
                exit: { command: "make", exitCode: 0, sessionId: 4, status: "completed" },
            },
        };

        runner.send(exit);
        runner.send(exit);

        await waitFor(() => runner.received.filter((frame) => frame.type === "ack").length === 2);
        expect(exits).toEqual([
            { command: "make", exitCode: 0, sessionId: 1, status: "completed" },
        ]);
    });
});

function link(): RunnerLink {
    const created = new RunnerLink(ctx, { name: "Build box", instanceId: "daemon-process" });
    links.push(created);
    return created;
}

function fakeRunner() {
    const [daemonEnd, runnerEnd] = createRunnerChannelPair();
    const received: RunnerFrameHeader[] = [];
    let answer: ((request: { method: string; params: unknown }) => unknown) | undefined;
    runnerEnd.receive({
        frame: (bytes) => {
            const { header } = decodeRunnerFrame(bytes);
            received.push(header);
            if (header.type === "request" && answer !== undefined) {
                send({ type: "response", id: header.id, result: answer(header) });
            }
        },
        close: () => undefined,
    });
    const send = (header: RunnerFrameHeader) => runnerEnd.send(encodeRunnerFrame(header));
    return {
        daemonEnd: daemonEnd as RunnerChannel,
        runnerEnd,
        received,
        send,
        answer: (respond: (request: { method: string; params: unknown }) => unknown) => {
            answer = respond;
        },
        async handshake() {
            send({ type: "hello", protocol: { min: 1, max: 1 }, runner: identity });
            await waitFor(() => received.some((frame) => frame.type === "welcome"));
            send({ type: "ready", epoch: "epoch-1", computes: [], streams: [] });
        },
    };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("The expected state never arrived.");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
