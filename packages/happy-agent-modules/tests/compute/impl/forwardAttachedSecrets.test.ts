import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { computePermissions, RunnerDisconnectedError } from "@slopus/happy-agent-compute";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { forwardAttachedSecrets } from "../../../sources/compute/impl/forwardAttachedSecrets.js";
import type { RunnersModule } from "../../../sources/runners/index.js";
import type { SecretsModule } from "../../../sources/secrets/index.js";
import { connectedRunner } from "../../support/connectedRunner.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    delete process.env["HAPPY_TEST_OTHER_TOKEN"];
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("attached secrets on a runner", () => {
    it("sends the selection with the one command and hides every other attached variable", async () => {
        const runner = await connectedRunner(cleanups);
        // The runner's own environment carries a variable of an attached secret nobody selected.
        process.env["HAPPY_TEST_OTHER_TOKEN"] = "the runner's own";
        const resolveForCommandTargets = vi.fn(async () => ({
            environment: { DEPLOY_TOKEN: "from the daemon" },
            hiddenEnvironmentVariables: ["DEPLOY_TOKEN", "HAPPY_TEST_OTHER_TOKEN"],
        }));
        const machine = forwardAttachedSecrets(await runner.runners.machine(runner.runnerId), {
            agentId: "agentone",
            ctx: createRootContext().named("forwarded-secrets"),
            secrets: { resolveForCommandTargets } as unknown as SecretsModule,
            targetScope: { workspaceId: "workspaceone", projectId: "projectone" },
        });
        const command = 'printf "%s|%s" "${DEPLOY_TOKEN-unset}" "${HAPPY_TEST_OTHER_TOKEN-unset}"';
        const permissions = computePermissions("full_access");

        const selected = await machine.shell.run({ command, permissions, secrets: ["deploy"] });
        expect(selected.stdout).toBe("from the daemon|unset");
        expect(resolveForCommandTargets).toHaveBeenCalledWith(
            expect.anything(),
            [
                { type: "agent", id: "agentone" },
                { type: "workspace", id: "workspaceone" },
                { type: "project", id: "projectone" },
            ],
            ["deploy"],
        );

        // Selecting nothing sends the command as it was, so an older runner still runs it.
        resolveForCommandTargets.mockClear();
        const plain = await machine.shell.run({ command, permissions, secrets: [] });
        expect(plain.stdout).toBe("unset|the runner's own");
        expect(resolveForCommandTargets).not.toHaveBeenCalled();
    });

    it("marks a background command started with secrets so its input is reviewed", async () => {
        const runner = await connectedRunner(cleanups);
        const machine = forwardAttachedSecrets(await runner.runners.machine(runner.runnerId), {
            agentId: "agentone",
            ctx: createRootContext().named("forwarded-secrets"),
            secrets: {
                resolveForCommandTargets: async () => ({
                    environment: { DEPLOY_TOKEN: "from the daemon" },
                    hiddenEnvironmentVariables: ["DEPLOY_TOKEN"],
                }),
            } as unknown as SecretsModule,
        });
        const permissions = computePermissions("full_access");

        const withSecrets = await machine.shell.startSession({
            command: "sleep 30",
            permissions,
            secrets: ["deploy"],
        });
        const without = await machine.shell.startSession({ command: "sleep 30", permissions });
        cleanups.push(async () => {
            await machine.shell.killAllSessions?.();
        });

        expect(machine.shell.sessionUsesSecrets?.(withSecrets)).toBe(true);
        expect(machine.shell.sessionUsesSecrets?.(without)).toBe(false);
    });

    it("leaves nothing of the values on the runner: not on disk, in its log, or in what it holds", async () => {
        const runner = await connectedRunner(cleanups);
        const machine = forwarding(await runner.runners.machine(runner.runnerId), {
            deploy: { DEPLOY_TOKEN: "deploy-value-on-runner" },
        });
        const permissions = computePermissions("full_access");

        const first = await machine.shell.run({
            command: 'printf "%s" "${DEPLOY_TOKEN-unset}"',
            permissions,
            secrets: ["deploy"],
        });
        expect(first.stdout).toBe("deploy-value-on-runner");
        // The next command, which selected nothing, gets nothing: the runner kept no copy.
        const next = await machine.shell.run({
            command: 'printf "%s" "${DEPLOY_TOKEN-unset}"',
            permissions,
        });
        expect(next.stdout).toBe("unset");

        // What the command arrived with on the runner was emptied once it had run.
        expect(runner.commands[0]?.environment).toEqual({});
        expect(runner.commands[1]?.environment).toBeUndefined();
        expect(runner.logs.join("\n")).not.toContain("deploy-value-on-runner");
        for (const file of await filesUnder(runner.home)) {
            expect(await readFile(file, "utf8").catch(() => "")).not.toContain(
                "deploy-value-on-runner",
            );
        }
    });

    it("gives each command only the secrets it selected, even while others run", async () => {
        const runner = await connectedRunner(cleanups);
        const machine = forwarding(await runner.runners.machine(runner.runnerId), {
            deploy: { DEPLOY_TOKEN: "deploy-value" },
            billing: { BILLING_TOKEN: "billing-value" },
        });
        const permissions = computePermissions("full_access");
        const command =
            'sleep 0.2; printf "%s|%s" "${DEPLOY_TOKEN-unset}" "${BILLING_TOKEN-unset}"';

        const [deploy, billing, neither] = await Promise.all([
            machine.shell.run({ command, permissions, secrets: ["deploy"] }),
            machine.shell.run({ command, permissions, secrets: ["billing"] }),
            machine.shell.run({ command, permissions }),
        ]);

        expect(deploy.stdout).toBe("deploy-value|unset");
        expect(billing.stdout).toBe("unset|billing-value");
        expect(neither.stdout).toBe("unset|unset");
    });

    it("never sends a command again after its connection drops, so a reconnect cannot resend its values", async () => {
        const runner = await connectedRunner(cleanups);
        const machine = forwarding(await runner.runners.machine(runner.runnerId), {
            deploy: { DEPLOY_TOKEN: "deploy-value" },
        });
        const permissions = computePermissions("full_access");

        const cut = machine.shell.run({
            command: "sleep 2",
            permissions,
            secrets: ["deploy"],
        });
        await vi.waitFor(() => expect(runner.commands).toHaveLength(1));
        runner.disconnect();
        await expect(cut).rejects.toBeInstanceOf(RunnerDisconnectedError);
        await runner.connect();

        const after = await machine.shell.run({ command: "true", permissions });
        expect(after.exitCode).toBe(0);
        // The runner received the cut command once, and only the new one since.
        expect(runner.commands).toHaveLength(2);
        expect(runner.commands[1]?.environment).toBeUndefined();
    });
});

/** A runner machine whose secret catalog resolves each bundle to its own variables. */
function forwarding(
    machine: Awaited<ReturnType<RunnersModule["machine"]>>,
    bundles: Record<string, Record<string, string>>,
) {
    const names = Object.values(bundles).flatMap((environment) => Object.keys(environment));
    return forwardAttachedSecrets(machine, {
        agentId: "agentone",
        ctx: createRootContext().named("forwarded-secrets"),
        secrets: {
            resolveForCommandTargets: async (
                _ctx: unknown,
                _targets: unknown,
                selected: readonly string[],
            ) => ({
                environment: Object.assign({}, ...selected.map((id) => bundles[id] ?? {})),
                hiddenEnvironmentVariables: names,
            }),
        } as unknown as SecretsModule,
    });
}

async function filesUnder(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name));
}
