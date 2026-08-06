import type { AgentContext } from "./AgentContext.js";
import type { GoalContext } from "./GoalContext.js";
import type { TaskContext } from "./TaskContext.js";
import type { UserInputContext } from "./UserInputContext.js";
import { createFileReadState } from "./FileReadState.js";
import type { WorkflowContext } from "../../workflows/index.js";
import {
    createPermissionContext,
    DEFAULT_PERMISSION_MODE,
    type PermissionMode,
} from "../../permissions/index.js";
import {
    CONTAINER_DOCS_PATH,
    createDockerBashContext,
    createDockerFileSystemContext,
    DockerEnvironment,
    type DockerExecutionConfig,
} from "../../execution/index.js";
import type { SessionSecretContext } from "../../secrets/index.js";
import type { PluginContext } from "./PluginContext.js";
import { posix } from "node:path";

export interface CreateDockerAgentContextOptions {
    docker: DockerExecutionConfig;
    goals?: GoalContext;
    permissionMode?: PermissionMode;
    plugins?: PluginContext;
    protectedPaths?: readonly string[];
    secrets?: SessionSecretContext;
    sessionId: string;
    tasks?: TaskContext;
    userInput?: UserInputContext;
    workflows?: WorkflowContext;
}

export function createDockerAgentContext(options: CreateDockerAgentContextOptions): AgentContext {
    const environment = new DockerEnvironment(options.docker, options.sessionId);
    const protectedPaths = (options.protectedPaths ?? []).map((path) =>
        posix.resolve(environment.config.workingDirectory, path),
    );
    const permissions = createPermissionContext(options.permissionMode ?? DEFAULT_PERMISSION_MODE, {
        protectedPaths,
    });
    const context: AgentContext = {
        bash: createDockerBashContext(
            environment,
            permissions,
            options.secrets,
            options.plugins?.network,
        ),
        docsPath: CONTAINER_DOCS_PATH,
        fileReads: createFileReadState(),
        fs: createDockerFileSystemContext(environment, permissions),
        permissions,
    };
    if (options.secrets !== undefined) context.secrets = options.secrets;
    if (options.userInput !== undefined) context.userInput = options.userInput;
    if (options.goals !== undefined) context.goals = options.goals;
    if (options.tasks !== undefined) context.tasks = options.tasks;
    if (options.workflows !== undefined) context.workflows = options.workflows;
    return context;
}
