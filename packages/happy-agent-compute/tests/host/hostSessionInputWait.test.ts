import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import type { Compute } from "../../sources/Compute.js";
import { computePermissions } from "../../sources/ComputePermissions.js";
import { createHostCompute } from "../../sources/host/index.js";

const ctx: Context = createRootContext().named("host-session-input-wait-test");
const computes: Compute[] = [];
const temporaryDirectories: string[] = [];
const fullAccessPermissions = computePermissions("full_access");

afterEach(async () => {
    await Promise.all(computes.splice(0).map((compute) => compute.dispose(ctx)));
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe.skipIf(process.platform !== "linux")("a host session waiting for input", () => {
    it("stops waiting as soon as the command blocks reading its input", async () => {
        const compute = await fullAccessCompute();
        // An empty file list makes grep read its input, which nothing will ever close.
        const sessionId = await compute.shell.startSession({
            command: 'f=$(true); grep -n "pattern" -A16 $f | head -40',
            permissions: fullAccessPermissions,
        });

        const startedAt = Date.now();
        const snapshot = await compute.shell.readSession(sessionId, { waitMs: 60_000 });

        expect(Date.now() - startedAt).toBeLessThan(10_000);
        expect(snapshot).toMatchObject({ status: "running" });
        expect(snapshot?.waitingForInput?.map((reader) => reader.command)).toEqual([
            expect.stringMatching(/^grep /u),
        ]);

        // grep reads on until its input ends, so after a line it is waiting again.
        await compute.shell.writeSession(fullAccessPermissions, sessionId, "a pattern line\n");
        const answered = await compute.shell.readSession(sessionId, { waitMs: 60_000 });
        expect(answered?.waitingForInput).toHaveLength(1);
        // A peek is an observer, not the reader the model relies on, and is told nothing.
        await expect(
            compute.shell.readSession(sessionId, { peek: true }),
        ).resolves.not.toHaveProperty("waitingForInput");
        await expect(compute.shell.killSession(sessionId)).resolves.toMatchObject({
            status: "killed",
        });
    }, 20_000);

    it("reports the wait to a later read of a command already in the background", async () => {
        const compute = await fullAccessCompute();
        const sessionId = await compute.shell.startSession({
            command: "sleep 1; read -r answer; echo got:$answer",
            permissions: fullAccessPermissions,
        });
        await expect(compute.shell.readSession(sessionId)).resolves.not.toHaveProperty(
            "waitingForInput",
        );

        const waiting = await compute.shell.readSession(sessionId, { waitMs: 60_000 });
        expect(waiting?.waitingForInput).toHaveLength(1);

        await compute.shell.writeSession(fullAccessPermissions, sessionId, "yes\n");
        const finished = await compute.shell.readSession(sessionId, { waitMs: 60_000 });
        expect(finished).toMatchObject({ status: "completed", stdout: "got:yes\n" });
        expect(finished).not.toHaveProperty("waitingForInput");
    }, 20_000);

    it("does not mistake a server, a sleeper, or a pipeline reader for one", async () => {
        const compute = await fullAccessCompute();
        const server = await compute.shell.startSession({
            command: `${process.execPath} -e "require('node:net').createServer().listen(0)"`,
            permissions: fullAccessPermissions,
        });
        const pipeline = await compute.shell.startSession({
            command: "sleep 30 | cat",
            permissions: fullAccessPermissions,
        });

        const startedAt = Date.now();
        const [serverSnapshot, pipelineSnapshot] = await Promise.all([
            compute.shell.readSession(server, { waitMs: 3_000 }),
            compute.shell.readSession(pipeline, { waitMs: 3_000 }),
        ]);

        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_900);
        expect(serverSnapshot).toMatchObject({ status: "running" });
        expect(serverSnapshot).not.toHaveProperty("waitingForInput");
        expect(pipelineSnapshot).toMatchObject({ status: "running" });
        expect(pipelineSnapshot).not.toHaveProperty("waitingForInput");
    }, 20_000);
});

async function fullAccessCompute(): Promise<Compute> {
    const root = await mkdtemp(join(tmpdir(), "host-input-wait-"));
    temporaryDirectories.push(root);
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const compute = createHostCompute({ ctx, cwd });
    computes.push(compute);
    return compute;
}
