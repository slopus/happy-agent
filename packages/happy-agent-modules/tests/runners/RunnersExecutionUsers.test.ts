import { userInfo } from "node:os";

import { withAgentConfig } from "@slopus/happy-agent-base";
import { computePermissions, RunnerUnavailableError } from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComputeModule } from "../../sources/compute/index.js";
import type { ConfigModule } from "../../sources/config/index.js";
import { RunnersModule } from "../../sources/runners/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { secretsMigrations } from "../../sources/secrets/SecretDatabase.js";
import { governedTree } from "../botSettings/support.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";
import { testConfig } from "../support/computeModule.js";

const GUEST_BOT = "guestbotid";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The real configuration, with an `[execution]` table as the machine happy.toml would give it. */
function withExecution(
    execution: { user: string; bots?: Record<string, string>; executable?: string } | undefined,
): ConfigModule {
    return new Proxy(testConfig, {
        get(target, property, receiver) {
            if (property === "execution") {
                return execution === undefined
                    ? undefined
                    : {
                          user: execution.user,
                          executable: execution.executable ?? "/usr/local/bin/happy-agent",
                          bots: execution.bots ?? {},
                      };
            }
            if (property === "runners") return { entries: {} };
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

function onThisMachine(ctx: Context, cwd: string): Context {
    return withAgentConfig(ctx, { modules: { compute: { cwd } } });
}

/** A runner machine as the compute package builds one: a plain object over a fake machine. */
function runnerMachine(cwd: string) {
    const machine = new FakeCompute(cwd);
    return {
        id: "runner",
        kind: machine.kind,
        cwd: machine.cwd,
        fs: machine.fs,
        shell: machine.shell,
        dispose: async (ctx: Context) => await machine.dispose(ctx),
    };
}

describe("work on this machine as Linux users", () => {
    it("routes a bot with a user of its own to that user's runner, and every other agent to the workload user's", async () => {
        const tree = await governedTree("execution-users-routing", secretsMigrations);
        cleanups.push(() => tree.close());
        const config = withExecution({ user: "happy-work", bots: { [GUEST_BOT]: "happy-guest" } });
        const runners = new RunnersModule(config, tree.botSettings);
        runners.bindBots([
            { id: GUEST_BOT, agentId: "botagent" },
            { id: "otherbotid", agentId: "otherbotagent" },
        ]);
        const localAgentMachine = vi
            .spyOn(runners, "localAgentMachine")
            .mockImplementation(async (_ctx, input) => runnerMachine(input.cwd) as never);
        const hostMachines: string[] = [];
        const compute = ComputeModule.withProvider(
            config,
            new SecretsModule(tree.botSettings),
            {
                id: "host",
                create: async (_ctx, machine) => {
                    hostMachines.push(machine.cwd);
                    return new FakeCompute(machine.cwd);
                },
            },
            runners,
            tree.botSettings,
        );
        cleanups.push(async () => await compute.dispose(tree.ctx));

        await compute.resolve(
            onThisMachine(tree.ctx, "/home/happy-work/happy/Bots/guest"),
            "botagent",
        );
        await compute.resolve(
            onThisMachine(tree.ctx, "/home/happy-work/project"),
            "collaboratoragent",
        );
        await compute.resolve(onThisMachine(tree.ctx, "/home/happy-work/other"), "otherchild");

        expect(
            localAgentMachine.mock.calls.map(([, input]) => [input.agentId, input.user]),
        ).toEqual([
            ["botagent", "happy-guest"],
            // A collaborator two levels under the bot is governed by it, so it runs as its user too.
            ["collaboratoragent", "happy-guest"],
            ["otherchild", "happy-work"],
        ]);
        // Nothing ran inside the daemon process.
        expect(hostMachines).toEqual([]);
        // Commands there resolve a selection through the daemon's catalog, which knows no such
        // secret here.
        const machine = await compute.resolve(
            onThisMachine(tree.ctx, "/home/happy-work/project"),
            "collaboratoragent",
        );
        await expect(
            machine!.shell.run({
                command: "true",
                permissions: computePermissions("workspace_write"),
                secrets: ["deploy"],
            }),
        ).rejects.toThrow("Secret 'deploy' is not attached to this agent.");
    });

    it("starts no agent work until it knows which bots run as their own user", async () => {
        const tree = await governedTree("execution-users-unbound");
        cleanups.push(() => tree.close());
        const config = withExecution({ user: "happy-work", bots: { [GUEST_BOT]: "happy-guest" } });
        const runners = new RunnersModule(config, tree.botSettings);

        await expect(runners.userFor(tree.ctx, "botagent")).rejects.toThrow(RunnerUnavailableError);
        runners.bindBots([{ id: GUEST_BOT, agentId: "botagent" }]);
        await expect(runners.userFor(tree.ctx, "subtaskagent")).resolves.toBe("happy-guest");
        await expect(runners.userFor(tree.ctx, "otherchild")).resolves.toBe("happy-work");
    });

    it("leaves the daemon running its own work while no user is configured", async () => {
        const tree = await governedTree("execution-users-none");
        cleanups.push(() => tree.close());
        const runners = new RunnersModule(withExecution(undefined), tree.botSettings);

        expect(runners.native()).toBe(true);
        expect(runners.machineHome(undefined)).toBeUndefined();
        await expect(runners.userFor(tree.ctx, "botagent")).resolves.toBeUndefined();
    });

    it("never runs work through the daemon's own user, and never falls back to this process", async () => {
        const tree = await governedTree("execution-users-self");
        cleanups.push(() => tree.close());
        const runners = new RunnersModule(
            withExecution({ user: userInfo().username }),
            tree.botSettings,
        );
        cleanups.push(async () => await runners.close());

        expect(runners.native()).toBe(false);
        await expect(runners.machine(undefined)).rejects.toThrow(
            `Agent work cannot run as the Linux user ${userInfo().username}, because that is the user this daemon runs as.`,
        );
        // With no runner started there is nowhere to put folders, and the reason says so.
        expect(() => runners.machineHome(undefined)).toThrow(RunnerUnavailableError);
    });

    it("fails a workload user whose runner sudo will not start, rather than running the work here", async () => {
        const tree = await governedTree("execution-users-sudo");
        cleanups.push(() => tree.close());
        // No sudoers rule allows this user, and in a test there is no root to grant one.
        const runners = new RunnersModule(
            withExecution({ user: "happy-no-such-user", executable: "/usr/local/bin/happy-agent" }),
            tree.botSettings,
        );
        cleanups.push(async () => await runners.close());

        const failure = await runners.machine(undefined).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(RunnerUnavailableError);
        expect((failure as Error).message).toMatch(
            /^Agent work cannot run as the Linux user happy-no-such-user: /u,
        );
        expect(() => runners.machineHome(undefined)).toThrow(
            /^Agent work cannot run as the Linux user happy-no-such-user: /u,
        );
    });
});
