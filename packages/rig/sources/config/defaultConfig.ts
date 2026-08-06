import type { RigConfig } from "./types.js";
import { detectP2pNodeName } from "./detectP2pNodeName.js";
import { DEFAULT_INFERENCE_MAX_RETRIES } from "./inferenceRetrySettings.js";

export const DEFAULT_RIG_CONFIG: RigConfig = {
    defaults: {
        modelId: "openai/gpt-5.6-sol",
        permissionMode: "auto",
    },
    features: {
        crossWorkspace: false,
        workflows: true,
        workspaces: true,
    },
    mcpServers: {},
    permissions: { protectedPaths: [] },
    p2p: {
        direct: {},
        enableDirect: false,
        enableIroh: true,
        enableSsh: false,
        exposeApi: false,
        iroh: {},
        name: detectP2pNodeName(),
        role: "primary",
    },
    presence: { states: {} },
    providerDefaultEnable: true,
    providers: {
        codex: {
            enabled: true,
            type: "codex",
        },
        claude: {
            enabled: true,
            type: "claude",
        },
        bedrock: {
            enabled: true,
            type: "bedrock",
        },
        grok: {
            enabled: true,
            type: "grok",
        },
    },
    settings: {
        inferenceMaxRetries: DEFAULT_INFERENCE_MAX_RETRIES,
        compactCompletedTurns: false,
        completionChime: false,
        daemonHeapSnapshots: false,
        durableGlobalEventQueue: false,
        happyIntegration: true,
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
    workspace: {
        setupCommands: [],
    },
};
