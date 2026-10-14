import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

interface FakeWorker {
    cwd: string;
    options: { hostPolicy?: unknown };
    disposed: boolean;
    keepAlive: () => boolean;
    pending: Array<() => void>;
    /** When set, `run` waits until the test releases it. */
    hold: boolean;
    warmed: number;
}

const created: FakeWorker[] = [];

vi.mock("@slopus/happy-agent-compute", () => ({
    computePermissions: (mode: string) => ({ mode, network: { egress: false } }),
    createHostCommandWorker: (options: {
        cwd: string;
        hostPolicy?: unknown;
        keepAlive: () => boolean;
    }) => {
        const worker: FakeWorker = {
            cwd: options.cwd,
            options,
            disposed: false,
            hold: false,
            keepAlive: options.keepAlive,
            pending: [],
            warmed: 0,
        };
        created.push(worker);
        return {
            dispose: async () => {
                worker.disposed = true;
            },
            run: async () => {
                if (worker.hold) await new Promise<void>((done) => worker.pending.push(done));
                return {
                    exitCode: 0,
                    stderr: "",
                    stdout: Buffer.alloc(0),
                    timedOut: false,
                    truncated: false,
                };
            },
            warm: () => {
                worker.warmed += 1;
            },
        };
    },
}));

const { GitScanWorkers } = await import("../../sources/git/impl/GitScanWorkers.js");

describe("GitScanWorkers", () => {
    it("keeps a worker while an agent run holds it or the tracker follows it", async () => {
        created.length = 0;
        const root = createRootContext();
        let tracked: string[] = [];
        const workers = new GitScanWorkers(
            () => root,
            () => tracked,
            () => 32,
            () => undefined,
        );
        const folder = process.platform === "win32" ? "C:\\Work\\Repo" : "/work/repo";

        // An agent run starts its folder's worker ahead of the first scan.
        const release = workers.hold(folder, undefined);
        expect(created).toHaveLength(1);
        expect(created[0]!.warmed).toBe(1);
        expect(created[0]!.keepAlive()).toBe(true);

        // Once the run settles, nothing keeps it.
        release();
        release();
        expect(created[0]!.keepAlive()).toBe(false);

        // The tracker following the same folder keeps it, however the path is spelled.
        tracked = [process.platform === "win32" ? "c:\\work\\repo\\" : "/work/repo/"];
        expect(created[0]!.keepAlive()).toBe(true);
        tracked = [];
        expect(created[0]!.keepAlive()).toBe(false);

        // Scans of the folder reuse the warmed worker instead of starting another.
        await workers.scanner(() => undefined)({ args: ["status"], cwd: folder });
        expect(created).toHaveLength(1);
        workers.dispose();
    });

    it("keeps a folder held while any one of several runs still holds it", () => {
        created.length = 0;
        const root = createRootContext();
        const workers = new GitScanWorkers(
            () => root,
            () => [],
            () => 32,
            () => undefined,
        );
        const folder = process.platform === "win32" ? "C:\\Work\\Shared" : "/work/shared";
        const first = workers.hold(folder, undefined);
        const second = workers.hold(folder, undefined);
        first();
        expect(created[0]!.keepAlive()).toBe(true);
        second();
        expect(created[0]!.keepAlive()).toBe(false);
        workers.dispose();
    });

    it("creates each worker with the host policy its constructor supplies", () => {
        created.length = 0;
        const hostPolicy = {
            privateDirectories: ["/home/user/.happy/agent"],
            protectedProjectFiles: ["AGENTS.md"],
        };
        let policy: typeof hostPolicy | undefined = hostPolicy;
        const workers = new GitScanWorkers(
            () => createRootContext(),
            () => [],
            () => 32,
            () => policy,
        );
        workers.hold(process.platform === "win32" ? "C:\\Work\\One" : "/work/one", undefined);
        expect(created[0]!.options.hostPolicy).toEqual(hostPolicy);
        expect(created[0]!.options.hostPolicy).toBe(hostPolicy);

        // Without a policy the key is omitted rather than passed as undefined.
        policy = undefined;
        workers.hold(process.platform === "win32" ? "C:\\Work\\Two" : "/work/two", undefined);
        expect("hostPolicy" in created[1]!.options).toBe(false);
        workers.dispose();
    });
    describe("with a limit of two workers", () => {
        const folder = (name: string) =>
            process.platform === "win32" ? `C:\\Work\\${name}` : `/work/${name}`;
        const make = (tracked: () => string[] = () => []) => {
            created.length = 0;
            const workers = new GitScanWorkers(
                () => createRootContext(),
                tracked,
                () => 2,
                () => undefined,
            );
            return { scan: workers.scanner(() => undefined), workers };
        };
        const worker = (name: string) => created.find((entry) => entry.cwd === folder(name))!;
        const scanOf = (scan: ReturnType<typeof make>["scan"], name: string) =>
            scan({ args: ["status"], cwd: folder(name) });

        it("stops the least recently used idle worker", async () => {
            const { scan, workers } = make();
            await scanOf(scan, "a");
            await scanOf(scan, "b");
            await scanOf(scan, "c");
            expect(worker("a").disposed).toBe(true);
            expect(worker("b").disposed).toBe(false);
            expect(worker("c").disposed).toBe(false);
            workers.dispose();
        });

        it("never stops a worker whose scan is still running", async () => {
            const { scan, workers } = make();
            await scanOf(scan, "a");
            worker("a").hold = true;
            const pending = scanOf(scan, "a");
            await scanOf(scan, "b");
            await scanOf(scan, "c");
            expect(worker("a").disposed).toBe(false);
            expect(worker("b").disposed).toBe(true);
            worker("a").pending.forEach((done) => done());
            await expect(pending).resolves.toBeDefined();
            workers.dispose();
        });

        it("never stops a held worker", async () => {
            const { scan, workers } = make();
            workers.hold(folder("a"), undefined);
            await scanOf(scan, "b");
            await scanOf(scan, "c");
            expect(worker("a").disposed).toBe(false);
            expect(worker("b").disposed).toBe(true);
            workers.dispose();
        });

        it("never stops a tracked worker", async () => {
            const { scan, workers } = make(() => [folder("a")]);
            await scanOf(scan, "a");
            await scanOf(scan, "b");
            await scanOf(scan, "c");
            expect(worker("a").disposed).toBe(false);
            expect(worker("b").disposed).toBe(true);
            workers.dispose();
        });

        it("goes over the limit when nothing can be stopped and trims once work finishes", async () => {
            const { scan, workers } = make();
            await scanOf(scan, "a");
            await scanOf(scan, "b");
            worker("a").hold = true;
            worker("b").hold = true;
            const first = scanOf(scan, "a");
            const second = scanOf(scan, "b");
            // A held third worker joins while both others are mid-scan, so nothing can be stopped.
            const release = workers.hold(folder("c"), undefined);
            expect(created.filter((entry) => !entry.disposed)).toHaveLength(3);

            await vi.waitFor(() => expect(worker("a").pending).toHaveLength(1));
            worker("a").pending.forEach((done) => done());
            await first;
            // The scan finished, so the idle worker beyond the limit goes.
            expect(worker("a").disposed).toBe(true);
            expect(created.filter((entry) => !entry.disposed)).toHaveLength(2);
            await vi.waitFor(() => expect(worker("b").pending).toHaveLength(1));
            worker("b").pending.forEach((done) => done());
            await second;
            release();
            workers.dispose();
        });
    });
});
