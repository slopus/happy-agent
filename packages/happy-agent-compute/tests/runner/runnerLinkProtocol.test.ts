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
    RunnerHost,
    RunnerLink,
    type RunnerChannel,
    type RunnerFrameHeader,
    type RunnerSystem,
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

/**
 * A runner that speaks only protocol version 1 makes `net.connect` from its own network even for a
 * container. Previewing an agent's container through it would reach the runner's loopback instead,
 * so the daemon refuses before sending anything.
 */
describe("connections into a container on a runner", () => {
    it.each([
        ["refuses a Docker machine on a version 1 runner", 1, true, false],
        ["connects a Docker machine on a version 2 runner", 2, true, true],
        ["still connects an ordinary machine on a version 1 runner", 1, false, true],
    ])("%s", async (_name, protocol, docker, sent) => {
        const runner = fakeRunner();
        const daemon = link();
        const accepted = daemon.accept(runner.daemonEnd);
        await runner.handshake(protocol);
        await accepted;
        runner.answer((request) =>
            request.method === "compute.create"
                ? {
                      cwd: "/work",
                      kind: docker ? "docker" : "host",
                      supportsSessionInput: true,
                      retained: false,
                  }
                : {},
        );
        const compute = await createRunnerCompute(ctx, {
            link: daemon,
            computeId: "agent-1",
            cwd: "/work",
            ...(docker ? { docker: { image: "ghcr.io/acme/dev:latest" } } : {}),
        });

        const connecting = compute.network!.connect(ctx, { host: "localhost", port: 3000 });

        if (sent) {
            const socket = await connecting;
            socket.destroy();
        } else {
            await expect(connecting).rejects.toMatchObject({ code: "ENOTSUP" });
        }
        const methods = runner.received.flatMap((frame) =>
            frame.type === "request" ? [frame.method] : [],
        );
        expect(methods.includes("net.connect")).toBe(sent);
    });

    it("checks the connection that carries the request, not the one before a reconnect", async () => {
        const daemon = link();
        const modern = fakeRunner();
        const acceptedModern = daemon.accept(modern.daemonEnd);
        await modern.handshake(2);
        await acceptedModern;
        modern.answer(() => ({
            cwd: "/work",
            kind: "docker",
            supportsSessionInput: true,
            retained: false,
        }));
        const compute = await createRunnerCompute(ctx, {
            link: daemon,
            computeId: "agent-1",
            cwd: "/work",
            docker: { image: "ghcr.io/acme/dev:latest" },
        });

        // The runner is replaced by an older one before the preview connects.
        const older = fakeRunner();
        const acceptedOlder = daemon.accept(older.daemonEnd);
        await older.handshake(1);
        await acceptedOlder;
        older.answer(() => ({
            cwd: "/work",
            kind: "docker",
            supportsSessionInput: true,
            retained: false,
        }));

        await expect(
            compute.network!.connect(ctx, { host: "localhost", port: 3000 }),
        ).rejects.toMatchObject({ code: "ENOTSUP" });
        const methods = [...modern.received, ...older.received].flatMap((frame) =>
            frame.type === "request" ? [frame.method] : [],
        );
        expect(methods).not.toContain("net.connect");
    });
});

/**
 * A daemon older than version 3 refuses unknown fields in `hello`, so a runner's operating system
 * and shell travel in `ready`, and only once both sides agreed on version 3.
 */
describe("what a runner says about its machine", () => {
    const system = { osVersion: "10.0.26100", shell: "C:\\Windows\\powershell.exe" };

    it("learns the runner's operating system and shell on version 3", async () => {
        const runner = fakeRunner();
        const daemon = link();
        const accepted = daemon.accept(runner.daemonEnd);
        await runner.handshake(3, system);

        await expect(accepted).resolves.toMatchObject({ runner: { ...identity, ...system } });
        expect(daemon.status().runner).toEqual({ ...identity, ...system });
    });

    it("ignores them on an older version", async () => {
        const runner = fakeRunner();
        const daemon = link();
        const accepted = daemon.accept(runner.daemonEnd);
        await runner.handshake(2, system);

        await accepted;
        expect(daemon.status().runner).toEqual(identity);
    });

    it("drops a runner that sends them in hello", async () => {
        const runner = fakeRunner();
        const accepting = link().accept(runner.daemonEnd);

        runner.send({
            type: "hello",
            protocol: { min: 1, max: 3 },
            runner: { ...identity, ...system },
        } as RunnerFrameHeader);

        await expect(accepting).rejects.toMatchObject({ code: "ERUNNERUNAVAILABLE" });
    });

    it.each([
        ["sends them in ready on version 3", 3, true],
        ["keeps them to itself on version 2", 2, false],
    ])("%s", async (_name, protocol, sent) => {
        const host = new RunnerHost({
            ctx,
            identity: { ...identity, ...system },
            createCompute: async () => {
                throw new Error("No machine is built here.");
            },
        });
        const daemon = fakeDaemon();
        const served = host.serve(daemon.runnerEnd);

        await waitFor(() => daemon.received.some((frame) => frame.type === "hello"));
        expect(daemon.received[0]).toMatchObject({ type: "hello", runner: identity });
        expect(daemon.received[0]).not.toHaveProperty("runner.osVersion");
        daemon.send({ type: "welcome", protocol, instanceId: "daemon", leaseGraceMs: 0 });
        await waitFor(() => daemon.received.some((frame) => frame.type === "ready"));
        const ready = daemon.received.find((frame) => frame.type === "ready");
        if (sent) expect(ready).toMatchObject({ system });
        else expect(ready).not.toHaveProperty("system");

        daemon.send({ type: "goodbye", reason: "The test finished." });
        await served;
        await host.dispose(ctx);
    });
});

/**
 * A command's own environment and a listener's port and owner rule arrive at protocol version 4.
 * An older runner would refuse the unknown field, or pick its own port and admit every local user,
 * so the daemon refuses before sending anything.
 */
describe("features a runner needs version 4 for", () => {
    it.each([
        ["refuses them on a version 3 runner", 3, false],
        ["sends them to a version 4 runner", 4, true],
    ])("%s", async (_name, protocol, sent) => {
        const runner = fakeRunner();
        const daemon = link();
        const accepted = daemon.accept(runner.daemonEnd);
        await runner.handshake(protocol);
        await accepted;
        runner.answer((request) =>
            request.method === "compute.create"
                ? { cwd: "/work", kind: "host", supportsSessionInput: true, retained: false }
                : request.method === "net.listen"
                  ? { port: 5432 }
                  : request.method === "shell.run"
                    ? { result: { stdout: "", stderr: "", exitCode: 0, timedOut: false } }
                    : {},
        );
        const compute = await createRunnerCompute(ctx, {
            link: daemon,
            computeId: "agent-1",
            cwd: "/work",
        });

        const running = compute.shell.run({
            command: "deploy",
            permissions: computePermissions("full_access"),
            environment: { TOKEN: "value" },
        });
        const listening = compute.network!.listen!(ctx, { port: 5432, ownerOnly: true });

        if (sent) {
            await running;
            (await listening).close();
        } else {
            await expect(running).rejects.toThrow(/too old to give a command attached secrets/u);
            await expect(listening).rejects.toMatchObject({ code: "ENOTSUP" });
        }
        const requests = runner.received.flatMap((frame) =>
            frame.type === "request" ? [frame] : [],
        );
        expect(requests.find((frame) => frame.method === "shell.run")?.params).toEqual(
            sent
                ? expect.objectContaining({
                      options: expect.objectContaining({ environment: { TOKEN: "value" } }),
                  })
                : undefined,
        );
        expect(requests.find((frame) => frame.method === "net.listen")?.params).toEqual(
            sent ? expect.objectContaining({ port: 5432, ownerOnly: true }) : undefined,
        );
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
        async handshake(protocol = 1, system?: RunnerSystem) {
            send({ type: "hello", protocol: { min: 1, max: protocol }, runner: identity });
            await waitFor(() => received.some((frame) => frame.type === "welcome"));
            send({
                type: "ready",
                epoch: "epoch-1",
                computes: [],
                streams: [],
                ...(system === undefined ? {} : { system }),
            });
        },
    };
}

/** A daemon's end of a channel, driven by hand to see exactly what a runner sends. */
function fakeDaemon() {
    const [daemonEnd, runnerEnd] = createRunnerChannelPair();
    const received: RunnerFrameHeader[] = [];
    daemonEnd.receive({
        frame: (bytes) => received.push(decodeRunnerFrame(bytes).header),
        close: () => undefined,
    });
    return {
        runnerEnd,
        received,
        send: (header: RunnerFrameHeader) => daemonEnd.send(encodeRunnerFrame(header)),
    };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("The expected state never arrived.");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
