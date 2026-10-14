import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { computePermissions } from "../../sources/ComputePermissions.js";
import {
    createHostCommandWorker,
    HostCommandWorkerUnavailableError,
    type HostCommandWorker,
} from "../../sources/host/createHostCommandWorker.js";

const run = (worker: HostCommandWorker) =>
    worker.run({ argv: ["git", "status"], maxOutputBytes: 1024, timeoutMs: 1_000 });

describe.runIf(process.platform === "win32")("createHostCommandWorker", () => {
    const disposals: (() => Promise<void>)[] = [];
    afterEach(async () => {
        for (const dispose of disposals.splice(0)) await dispose();
    });

    // Node rejects the supervisor's arguments and exits at once, which is how a worker whose
    // sandbox cannot start looks from the outside.
    async function failingWorker(): Promise<HostCommandWorker> {
        const cwd = await mkdtemp(join(tmpdir(), "happy-worker-unit-"));
        const worker = createHostCommandWorker({
            ctx: createRootContext().named("worker-unit-test"),
            cwd,
            permissions: computePermissions("read_only"),
            supervisorPath: process.execPath,
        });
        disposals.push(async () => {
            await worker.dispose();
            await rm(cwd, { force: true, recursive: true });
        });
        return worker;
    }

    it("waits before starting again after a failed start, instead of retrying per command", async () => {
        const worker = await failingWorker();
        await expect(run(worker)).rejects.toBeInstanceOf(HostCommandWorkerUnavailableError);
        const started = Date.now();
        const refused = await run(worker).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(HostCommandWorkerUnavailableError);
        expect((refused as Error).message).toMatch(/try again in about 1 minute/u);
        // Refused without starting and waiting on another process.
        expect(Date.now() - started).toBeLessThan(500);
    });

    it("shares one start between commands that arrive together", async () => {
        const worker = await failingWorker();
        worker.warm();
        const outcomes = await Promise.allSettled([run(worker), run(worker), run(worker)]);
        for (const outcome of outcomes) {
            expect(outcome.status).toBe("rejected");
            if (outcome.status === "rejected") {
                expect(outcome.reason).toBeInstanceOf(HostCommandWorkerUnavailableError);
            }
        }
    });
});
