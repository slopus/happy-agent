import { describe, expect, it } from "vitest";

import { createSlashCommands } from "./createSlashCommands.js";

describe("createSlashCommands", () => {
    it("offers plugin status and logs after the first-screen task command", () => {
        const commands = createSlashCommands();
        const pluginIndex = commands.findIndex((command) => command.value === "plugins");

        expect(commands[pluginIndex]).toEqual({
            aliases: [],
            description: "Show plugins, or add a name to read its current log.",
            label: "/plugins",
            value: "plugins",
        });
        expect(commands.slice(0, pluginIndex).map((command) => command.value)).toEqual([
            "model",
            "context",
            "effort",
            "fast",
            "configure",
            "permissions",
            "mcp",
            "tasks",
        ]);
    });

    it("offers live process debugging", () => {
        expect(createSlashCommands().find((command) => command.value === "debug")).toMatchObject({
            label: "/debug",
            description: "Start live process debugging.",
        });
    });

    it("offers a TUI reload that reconnects the current session", () => {
        expect(createSlashCommands().find((command) => command.value === "reload")).toMatchObject({
            label: "/reload",
            description: "Restart the TUI and reconnect this session.",
        });
    });

    it("describes secret attachments without limiting them to the session scope", () => {
        expect(createSlashCommands().find((command) => command.value === "secrets")).toMatchObject({
            label: "/secrets",
            description: "Manage secret bundles and attachments.",
        });
    });
});
