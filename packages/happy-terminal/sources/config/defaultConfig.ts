import type { HappyTerminalConfig } from "./types.js";

export const DEFAULT_HAPPY_TERMINAL_CONFIG: HappyTerminalConfig = {
    defaults: {
        modelId: "openai/gpt-5.6-sol",
        permissionMode: "auto",
    },
    settings: {
        compactCompletedTurns: false,
        completionChime: false,
        showReasoning: false,
        showUsage: false,
    },
    theme: {
        accent: "cyan",
        brand: "ansi:202",
        error: "red",
        primary: "default",
        secondary: "dim",
        success: "green",
        warning: "yellow",
    },
};
