import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";

import { ensureAgentDatabaseConnection } from "@slopus/happy-agent-base";
import { runnerListResponseSchema, type RunnerListResponse } from "@slopus/happy-agent-client";
import {
    computePermissions,
    createHostCompute,
    createRunnerChannelPair,
    RUNNER_PROTOCOL_VERSION,
    RunnerHost,
} from "@slopus/happy-agent-compute";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import type { ConfigModule, RunnerConfig } from "../../sources/config/index.js";
import { LocalExecutionDisabledError, RunnersModule } from "../../sources/runners/index.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

const TOKEN = "a".repeat(43);
const OTHER_TOKEN = "b".repeat(43);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(entries: Record<string, RunnerConfig>, defaultId?: string) {
    const config = {
        get runners() {
            return {
                ...(defaultId === undefined ? {} : { defaultId }),
                entries: structuredClone(entries),
            };
        },
    } as ConfigModule;
    const module = new RunnersModule(config);
    const database: ModuleDatabase = moduleDatabase(module.migrations, "runners-test");
    ensureAgentDatabaseConnection(database.database);
    await database.ready;
    module.beforeStart(database.context);
    cleanups.push(() => database.close());
    cleanups.push(async () => await module.close());
    return { module, ctx: database.context, root: database.rootContext };
}

async function runnerHome(): Promise<string> {
    const home = await realpath(await mkdtemp(join(tmpdir(), "happy-runner-")));
    cleanups.push(async () => await rm(home, { force: true, recursive: true }));
    return home;
}

function waitForUpdate(
    module: RunnersModule,
    matches: (snapshot: RunnerListResponse) => boolean,
): Promise<RunnerListResponse> {
    return new Promise((resolve) => {
        const stop = module.onUpdated((_ctx, snapshot) => {
            if (!matches(snapshot)) return;
            stop();
            resolve(snapshot);
        });
    });
}

describe("runners", () => {
    it("knows each runner only by its own token", async () => {
        const { module } = await fixture(
            {
                "build-box": { name: "Build box", token: TOKEN },
                spare: { name: "Spare", token: OTHER_TOKEN },
            },
            "build-box",
        );
        expect(module.authenticate(`Bearer ${TOKEN}`)).toBe("build-box");
        expect(module.authenticate(`Bearer ${OTHER_TOKEN}`)).toBe("spare");
        expect(module.authenticate(`Bearer ${"c".repeat(43)}`)).toBeUndefined();
        expect(module.authenticate(TOKEN)).toBeUndefined();
        expect(module.authenticate(undefined)).toBeUndefined();
        expect(module.authenticate([`Bearer ${TOKEN}`])).toBeUndefined();
    });

    it("places folders on the named runner or the default, and refuses local work", async () => {
        const { module } = await fixture(
            { "build-box": { name: "Build box", token: TOKEN } },
            "build-box",
        );
        expect(module.place(undefined)).toEqual({ runnerId: "build-box" });
        expect(module.place("build-box")).toEqual({ runnerId: "build-box" });
        expect(() => module.place("elsewhere")).toThrow(/No runner called "elsewhere"/);
        expect(() => module.assertLocalExecution()).toThrow(LocalExecutionDisabledError);
    });

    it("runs everything on this machine when no runner is configured", async () => {
        const { module } = await fixture({});
        expect(module.localExecution).toBe(true);
        expect(module.place(undefined)).toEqual({});
        expect(() => module.assertLocalExecution()).not.toThrow();
        expect((await module.getSnapshot((await fixture({})).ctx)).runners).toEqual([]);
    });

    it("keeps this machine as the default while runners are configured for named folders", async () => {
        const { module } = await fixture({ "build-box": { name: "Build box", token: TOKEN } });
        expect(module.localExecution).toBe(true);
        expect(module.defaultRunnerId).toBeUndefined();
        expect(module.place(undefined)).toEqual({});
        expect(module.place("build-box")).toEqual({ runnerId: "build-box" });
        expect(() => module.assertLocalExecution()).not.toThrow();
    });

    it("names and describes folders on a runner by the platform it reports", async () => {
        const { module, root } = await fixture(
            {
                "windows-box": { name: "Windows box", token: TOKEN },
                "mac-box": { name: "Mac box", token: OTHER_TOKEN },
            },
            "windows-box",
        );
        const connect = async (id: string, platform: string, home: string) => {
            const host = new RunnerHost({
                ctx: root.named(`test-runner-${id}`),
                identity: { version: "9.9.9", platform, arch: "arm64", hostname: id, home },
                createCompute: async (computeCtx, request) =>
                    createHostCompute({ ctx: computeCtx, cwd: request.cwd }),
            });
            cleanups.push(async () => await host.dispose(root.named(`test-runner-${id}-dispose`)));
            const connected = waitForUpdate(module, (snapshot) =>
                snapshot.runners.some(
                    (runner) => runner.id === id && runner.status === "connected",
                ),
            );
            const [daemonSide, runnerSide] = createRunnerChannelPair();
            void module.accept(id, daemonSide);
            void host.serve(runnerSide);
            cleanups.push(() => runnerSide.close("The test is over."));
            await connected;
        };
        await connect("windows-box", "win32", "C:\\Users\\runner");
        await connect("mac-box", "darwin", "/Users/runner");

        expect(module.platform("windows-box")).toBe("win32");
        expect(module.paths("windows-box")).toBe(win32);
        expect(module.paths("mac-box")).toBe(posix);
        expect(
            module.paths("windows-box").join(module.home("windows-box")!, "Happy", "Projects"),
        ).toBe("C:\\Users\\runner\\Happy\\Projects");
        expect(module.environment("windows-box", "C:\\Users\\runner\\rig")).toEqual({
            osVersion: "Windows",
            platform: "win32",
            shell: "",
            workingDirectory: "C:\\Users\\runner\\rig",
        });
        expect(module.environment("mac-box", "/Users/runner/rig")).toMatchObject({
            osVersion: "macOS",
            platform: "darwin",
        });
        expect(module.environment(undefined, "/srv/rig")).toMatchObject({
            platform: process.platform,
            workingDirectory: "/srv/rig",
        });
    });

    it("reports a runner's connection and machine, and keeps the machine across a drop", async () => {
        const home = await runnerHome();
        const { module, ctx, root } = await fixture(
            { "build-box": { name: "Build box", token: TOKEN } },
            "build-box",
        );
        const before = await module.getSnapshot(ctx);
        expect(Value.Check(runnerListResponseSchema, before)).toBe(true);
        expect(before.runners).toEqual([
            expect.objectContaining({
                id: "build-box",
                name: "Build box",
                default: true,
                status: "disconnected",
                machine: null,
                protocol: null,
            }),
        ]);

        const host = new RunnerHost({
            ctx: root.named("test-runner"),
            identity: {
                version: "9.9.9",
                platform: "linux",
                arch: "x64",
                hostname: "build-1",
                home,
            },
            createCompute: async (computeCtx, request) =>
                createHostCompute({ ctx: computeCtx, cwd: request.cwd }),
        });
        cleanups.push(async () => await host.dispose(root.named("test-runner-dispose")));
        const connected = waitForUpdate(
            module,
            (snapshot) => snapshot.runners[0]?.status === "connected",
        );
        const [daemonSide, runnerSide] = createRunnerChannelPair();
        void module.accept("build-box", daemonSide);
        const served = host.serve(runnerSide);
        const online = await connected;
        expect(online.version > before.version).toBe(true);
        expect(online.runners[0]).toMatchObject({
            status: "connected",
            // A runner from the same SDK speaks its newest protocol.
            protocol: RUNNER_PROTOCOL_VERSION,
            reason: null,
            machine: {
                version: "9.9.9",
                platform: "linux",
                arch: "x64",
                hostname: "build-1",
                home,
            },
        });
        expect(module.home("build-box")).toBe(home);

        const machine = await module.machine("build-box");
        const permissions = computePermissions("full_access");
        await machine.fs.writeFile(permissions, join(home, "hello.txt"), "from the daemon");
        expect(await machine.fs.readFile(permissions, join(home, "hello.txt"))).toBe(
            "from the daemon",
        );

        const dropped = waitForUpdate(
            module,
            (snapshot) => snapshot.runners[0]?.status === "disconnected",
        );
        runnerSide.close("The runner went away.");
        await served;
        const offline = await dropped;
        expect(offline.runners[0]).toMatchObject({ status: "disconnected", protocol: null });
        expect(offline.runners[0]?.machine?.home).toBe(home);
        expect(offline.runners[0]?.reason).toEqual(expect.any(String));
        expect(await module.getSnapshot(ctx)).toEqual(offline);
    });
});
