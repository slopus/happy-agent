import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computePermissions, NativeProcessManager } from "@slopus/happy-agent-compute";
import { withAgentConfig } from "@slopus/happy-agent-base";
import { describe, expect, it } from "vitest";

import { ComputeModule } from "../../sources/compute/index.js";
import { createAttachedSecretsHostShell } from "../../sources/compute/impl/createAttachedSecretsHostShell.js";
import {
    GLOBAL_SECRET_OWNER_ID,
    SecretsModule,
    secretsMigrations,
} from "../../sources/secrets/index.js";
import { testConfig } from "../support/computeModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const AGENT_ID = "compute-secrets-agent";
const fullAccess = computePermissions("full_access");
const auto = computePermissions("auto");

describe("compute secret attachments", () => {
    it("resolves the global catalog through each agent's own attachment scope", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "compute-secret-module-"));
        const database = moduleDatabase(secretsMigrations, "compute-secret-module");
        await database.ready;
        const secrets = new SecretsModule();
        await secrets.register(database.context, GLOBAL_SECRET_OWNER_ID, {
            id: "selected",
            description: "The selected test token",
            environment: { HAPPY_SELECTED_TOKEN: "selected-value" },
        });
        await secrets.attach(database.context, GLOBAL_SECRET_OWNER_ID, AGENT_ID, "selected");
        const module = new ComputeModule(testConfig, secrets);
        const agentCtx = withAgentConfig(database.context, {
            modules: { compute: { cwd } },
        });
        try {
            const compute = await module.resolve(agentCtx, AGENT_ID);
            const result = await compute!.shell.run({
                command: "printf '%s' \"$HAPPY_SELECTED_TOKEN\"",
                permissions: auto,
                secrets: ["selected"],
            });
            expect(result).toMatchObject({ exitCode: 0, stdout: "selected-value" });

            const otherCompute = await module.resolve(agentCtx, "another-agent");
            await expect(
                otherCompute!.shell.run({
                    command: "printf '%s' \"$HAPPY_SELECTED_TOKEN\"",
                    permissions: auto,
                    secrets: ["selected"],
                }),
            ).rejects.toThrow("not attached");
        } finally {
            await module.dispose(agentCtx);
            database.close();
            await rm(cwd, { force: true, recursive: true });
        }
    });

    it("builds each command environment from only its selected attached bundles", async () => {
        const fixture = await secretShell("compute-secret-environment");
        try {
            const selected = await fixture.shell.run({
                command:
                    'printf \'%s|%s\' "${HAPPY_SELECTED_TOKEN-unset}" "${HAPPY_UNSELECTED_TOKEN-unset}"',
                permissions: fullAccess,
                secrets: ["selected"],
            });
            expect(selected.stdout).toBe("selected-value|unset");
            expect(selected.exitCode).toBe(0);

            const none = await fixture.shell.run({
                command:
                    'printf \'%s|%s\' "${HAPPY_SELECTED_TOKEN-unset}" "${HAPPY_UNSELECTED_TOKEN-unset}"',
                permissions: fullAccess,
            });
            expect(none.stdout).toBe("unset|unset");
        } finally {
            await fixture.close();
        }
    });

    it("provides selected secrets without leaving the sandbox", async () => {
        const fixture = await secretShell("compute-secret-permissions");
        try {
            await expect(
                fixture.shell.run({
                    command: "printf '%s' \"$HAPPY_SELECTED_TOKEN\"",
                    permissions: auto,
                    secrets: ["selected"],
                }),
            ).resolves.toMatchObject({ exitCode: 0, stdout: "selected-value" });
        } finally {
            await fixture.close();
        }
    });

    it("keeps background input under the secret-bearing process's existing sandbox", async () => {
        const fixture = await secretShell("compute-secret-background-input");
        try {
            const sessionId = await fixture.shell.startSession({
                command: 'IFS= read -r value; printf \'%s:%s\' "$HAPPY_SELECTED_TOKEN" "$value"',
                permissions: auto,
                secrets: ["selected"],
            });
            expect(fixture.shell.sessionUsesSecrets?.(sessionId)).toBe(true);

            await expect(fixture.shell.writeSession(auto, sessionId, "hello\n")).resolves.toBe(
                true,
            );

            const finished = await fixture.shell.readSession(sessionId, { waitMs: 30_000 });
            expect(finished).toMatchObject({
                exitCode: 0,
                status: "completed",
                stdout: "selected-value:hello",
            });
        } finally {
            await fixture.close();
        }
    });
});

async function secretShell(name: string) {
    const cwd = await mkdtemp(join(tmpdir(), `${name}-`));
    const database = moduleDatabase(secretsMigrations, name);
    await database.ready;
    const secrets = new SecretsModule();
    await secrets.register(database.context, GLOBAL_SECRET_OWNER_ID, {
        id: "selected",
        description: "The selected test token",
        environment: { HAPPY_SELECTED_TOKEN: "selected-value" },
    });
    await secrets.register(database.context, GLOBAL_SECRET_OWNER_ID, {
        id: "unselected",
        description: "A token this command must not receive",
        environment: { HAPPY_UNSELECTED_TOKEN: "catalog-value" },
    });
    await secrets.attach(database.context, GLOBAL_SECRET_OWNER_ID, AGENT_ID, "selected");
    await secrets.attach(database.context, GLOBAL_SECRET_OWNER_ID, AGENT_ID, "unselected");

    const processContext = database.rootContext.named(`${name}.processes`);
    const processManager = new NativeProcessManager(processContext);
    const shell = createAttachedSecretsHostShell({
        agentId: AGENT_ID,
        ctx: processContext,
        cwd,
        environment: {
            ...process.env,
            HAPPY_SELECTED_TOKEN: "ambient-selected-leak",
            HAPPY_UNSELECTED_TOKEN: "ambient-unselected-leak",
        },
        hostPolicy: {},
        processManager,
        secrets,
    });

    return {
        shell,
        close: async (): Promise<void> => {
            await shell.killAllSessions?.();
            await processManager.killAll(processContext, {
                forceAfterMs: 100,
                includeDetached: true,
            });
            database.close();
            await rm(cwd, { force: true, recursive: true });
        },
    };
}
