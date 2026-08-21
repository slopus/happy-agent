import type { AutocompleteItem } from "@earendil-works/pi-tui";

export interface SlashCommandItem extends AutocompleteItem {
    aliases: readonly string[];
}

export function createSlashCommands(
    options: { workflowsEnabled?: boolean } = {},
): SlashCommandItem[] {
    const commands: SlashCommandItem[] = [
        {
            value: "model",
            label: "/model",
            description: "Choose the model and reasoning level.",
            aliases: [],
        },
        {
            value: "context",
            label: "/context",
            description: "Add background context for the next request.",
            aliases: [],
        },
        {
            value: "effort",
            label: "/effort",
            description: "Change reasoning for this session.",
            aliases: ["ford", "reasoning"],
        },
        {
            value: "fast",
            label: "/fast",
            description: "Toggle fastest inference at 2× plan usage.",
            aliases: [],
        },
        {
            value: "configure",
            label: "/configure",
            description: "Configure app settings.",
            aliases: ["config", "settings"],
        },
        {
            value: "permissions",
            label: "/permissions",
            description: "Choose filesystem, shell, and network access.",
            aliases: ["permission"],
        },
        {
            value: "mcp",
            label: "/mcp",
            description: "Show configured MCP server connections.",
            aliases: [],
        },
        {
            value: "tasks",
            label: "/tasks",
            description: "Show the current session task list.",
            aliases: ["todos"],
        },
        {
            value: "plugins",
            label: "/plugins",
            description: "Show plugins, or add a name to read its current log.",
            aliases: [],
        },
        {
            value: "presence",
            label: "/presence",
            description: "Say whether you are here to answer questions.",
            aliases: ["away"],
        },
        {
            value: "debug",
            label: "/debug",
            description: "Start live process debugging.",
            aliases: [],
        },
        {
            value: "usage",
            label: "/usage",
            description: "Show token usage for this session.",
            aliases: ["tokens"],
        },
        {
            value: "agents",
            label: "/agents",
            description: "Show delegated work and its current status.",
            aliases: [],
        },
        {
            value: "secrets",
            label: "/secrets",
            description: "Manage secret bundles and attachments.",
            aliases: [],
        },
        {
            value: "ps",
            label: "/ps",
            description: "List background terminals.",
            aliases: [],
        },
        {
            value: "stop",
            label: "/stop",
            description: "Stop all background terminals.",
            aliases: [],
        },
        {
            value: "goal",
            label: "/goal",
            description: "Set or manage a persistent long-running goal.",
            aliases: [],
        },
        {
            value: "new",
            label: "/new",
            description: "Reset this session and start fresh.",
            aliases: ["reset"],
        },
        {
            value: "reload",
            label: "/reload",
            description: "Restart the TUI and reconnect this session.",
            aliases: [],
        },
        {
            value: "exit",
            label: "/exit",
            description: "Close Happy Terminal.",
            aliases: [],
        },
        {
            value: "clear",
            label: "/clear",
            description: "Clear the visible conversation.",
            aliases: [],
        },
        {
            value: "compact",
            label: "/compact",
            description: "Summarize older messages to free context space.",
            aliases: [],
        },
        {
            value: "abort",
            label: "/abort",
            description: "Stop the current response and background commands.",
            aliases: [],
        },
    ];
    if (options.workflowsEnabled !== false) {
        const usageIndex = commands.findIndex((command) => command.value === "usage");
        commands.splice(usageIndex, 0, {
            value: "workflows",
            label: "/workflows",
            description: "Open the live workflow monitor.",
            aliases: ["workflow"],
        });
    }
    return commands;
}
