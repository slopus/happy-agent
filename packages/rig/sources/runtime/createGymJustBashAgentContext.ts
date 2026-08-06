import { Bash, InMemoryFs, MountableFs, ReadWriteFs } from "just-bash";

import {
    createJustBashAgentContext,
    type AgentContext,
    type GoalContext,
    type TaskContext,
    type UserInputContext,
} from "../agent/index.js";
import {
    createPermissionContext,
    DEFAULT_PERMISSION_MODE,
    type PermissionMode,
} from "../permissions/index.js";
import type { SessionSecretContext } from "../secrets/index.js";
import type { WorkflowContext } from "../workflows/index.js";

export interface CreateGymJustBashAgentContextOptions {
    goals?: GoalContext;
    permissionMode?: PermissionMode;
    protectedPaths?: readonly string[];
    secrets?: SessionSecretContext;
    tasks?: TaskContext;
    userInput?: UserInputContext;
    workflows?: WorkflowContext;
}

export function createGymJustBashAgentContext(
    options: CreateGymJustBashAgentContextOptions = {},
): AgentContext {
    const workspacePath = requiredEnvironmentPath("RIG_GYM_WORKSPACE_PATH");
    const homePath = requiredEnvironmentPath("RIG_GYM_HOME_PATH");
    const fs = new MountableFs({
        base: new InMemoryFs(),
        mounts: [
            { filesystem: new ReadWriteFs({ root: workspacePath }), mountPoint: "/workspace" },
            { filesystem: new ReadWriteFs({ root: homePath }), mountPoint: "/home/rig" },
        ],
    });
    const permissions = createPermissionContext(options.permissionMode ?? DEFAULT_PERMISSION_MODE, {
        protectedPaths: (options.protectedPaths ?? []).map((path) =>
            path.startsWith("/") ? path : `/workspace/${path}`,
        ),
    });
    const context = createJustBashAgentContext(
        new Bash({ cwd: "/workspace", fs }),
        "/workspace",
        permissions,
    );
    context.fs.home = "/home/rig";
    if (options.secrets !== undefined) context.secrets = options.secrets;
    if (options.userInput !== undefined) context.userInput = options.userInput;
    if (options.goals !== undefined) context.goals = options.goals;
    if (options.tasks !== undefined) context.tasks = options.tasks;
    if (options.workflows !== undefined) context.workflows = options.workflows;
    return context;
}

function requiredEnvironmentPath(name: "RIG_GYM_HOME_PATH" | "RIG_GYM_WORKSPACE_PATH"): string {
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
        throw new Error(`${name} is required for the Gym JustBash runtime.`);
    }
    return value;
}
