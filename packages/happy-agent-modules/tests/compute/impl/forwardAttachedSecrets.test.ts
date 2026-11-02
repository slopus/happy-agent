import { computePermissions } from "@slopus/happy-agent-compute";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { forwardAttachedSecrets } from "../../../sources/compute/impl/forwardAttachedSecrets.js";
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
});
