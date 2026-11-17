import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("pasted Claude setup tokens", () => {
    it("saves a wrapped token, announces it without secrets, and preserves disabled settings across restart", async () => {
        const gym = await createAgentGym({
            config: '[providers.claude]\nenabled = false\ncredential_isolation = true\nname = "My Claude"',
            environment: {
                PATH: "",
                HAPPY_AGENT_PROGRAM_DIRECTORIES: "",
                HAPPY_AGENT_APPLICATIONS_DIRECTORY: "",
            },
        });
        running.add(gym);
        const token = "sk-ant-oat01-synthetic_wrapped-token";
        const response = await gym.client.saveClaudeSetupToken({
            token: "\ufeff sk-ant-\r\noat01-\tsynthetic_\u0085wrapped-\u00a0token\u2003",
            mutationId: "save-claude-token",
        });
        expect(response.providerCli).toMatchObject({
            id: "claude",
            signIn: { acceptsToken: true },
            operation: null,
        });
        const runtimePath = join(gym.happyHome, "agent", "runtime.toml");
        expect(await readFile(runtimePath, "utf8")).toContain(`oauth_token = "${token}"`);
        const config = await gym.client.getConfig();
        expect(config.config.providers.claude).toMatchObject({ enabled: false, name: "My Claude" });
        const changed = await gym.waitForEvent(
            (event) =>
                event.type === "provider_cli.updated" &&
                event.payload.mutationId === "save-claude-token",
            "the saved token's provider update",
        );
        const configured = await gym.waitForEvent(
            (event) =>
                event.type === "config.updated" && event.payload.mutationId === "save-claude-token",
            "the saved token's configuration update",
        );
        expect(JSON.stringify([response, config, changed, configured])).not.toContain(token);
        await gym.restart();
        expect(await readFile(runtimePath, "utf8")).toContain(`oauth_token = "${token}"`);
        expect((await gym.client.getConfig()).config.providers.claude).toMatchObject({
            enabled: false,
        });
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("rejects malformed tokens without replacing the previously saved credential", async () => {
        const gym = await createAgentGym({
            environment: {
                PATH: "",
                HAPPY_AGENT_PROGRAM_DIRECTORIES: "",
                HAPPY_AGENT_APPLICATIONS_DIRECTORY: "",
            },
        });
        running.add(gym);
        await gym.client.saveClaudeSetupToken({ token: "sk-ant-oat01-previous" });
        const runtimePath = join(gym.happyHome, "agent", "runtime.toml");
        const before = await readFile(runtimePath, "utf8");
        for (const token of [
            "",
            " \t\r\n\u0085",
            "sk-ant-api03-wrong-kind",
            "sk-ant-oat01-",
            "sk-ant-oat01-bad!",
            `sk-ant-oat01-${"a".repeat(8192)}`,
        ]) {
            await expect(gym.client.saveClaudeSetupToken({ token })).rejects.toMatchObject({
                status: 400,
                code: "invalid_request",
            });
            expect(await readFile(runtimePath, "utf8")).toBe(before);
        }
        expect((await gym.client.getProviderCli("claude")).providerCli.signIn.acceptsToken).toBe(
            true,
        );
        expect(gym.errors).toEqual([]);
    }, 60_000);
});
