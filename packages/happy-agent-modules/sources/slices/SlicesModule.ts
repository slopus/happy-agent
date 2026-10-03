import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AgentSystemRef,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import { cuid2Schema } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { BotsModule } from "../bots/index.js";
import type { ConfigModule } from "../config/index.js";
import { ProjectFileError, type ProjectFileRoot, type ProjectFilesModule } from "../files/index.js";
import type { ProjectsModule } from "../projects/index.js";
import type { WorkspacesModule } from "../workspaces/index.js";
import {
    MAX_SLICE_LISTED_FILES,
    SliceError,
    sliceCreateInputSchema,
    slicePresentationSchema,
    type SliceCreateInput,
    type SliceCreated,
    type SlicePresentation,
} from "./Slice.js";
import { createSliceTool } from "./tools/create_slice.js";

/**
 * Slices: gitignore-style masks an agent lays over a workspace's files for one question.
 *
 * The module stores nothing. A slice is its definition — a title, a source, include and exclude
 * rules, and any paths named outright — and the `create_slice` call that made it is the slice:
 * the transcript card carries the whole definition and the workspace it was evaluated against,
 * and the app evaluates it again through the file-match route whenever it shows it. The module
 * gives every model the tool, resolves which workspace the acting agent belongs to, and refuses a
 * mask that holds nothing so the agent can write a better one.
 */
export class SlicesModule implements AgentModule {
    readonly name = "slices";

    readonly #bots: BotsModule;
    readonly #config: ConfigModule;
    readonly #files: ProjectFilesModule;
    readonly #projects: ProjectsModule;
    readonly #workspaces: WorkspacesModule;
    #agents: AgentSystemRef | undefined;

    constructor(
        config: ConfigModule,
        bots: BotsModule,
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
        files: ProjectFilesModule,
    ) {
        this.#config = config;
        this.#bots = bots;
        this.#projects = projects;
        this.#workspaces = workspaces;
        this.#files = files;
    }

    readonly #hooks: AgentModuleHooks = {
        tools: (_ctx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => [
            createSliceTool(this, scope.agent.id),
        ],
    };

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

    /**
     * Evaluate a slice definition in the acting agent's workspace and answer the card for it.
     *
     * Membership comes from durable placement, never from a workspace ID the model supplies: the
     * agent's bot, its workspace, or its project root, walking up to the parent agent for a
     * collaborator that has no placement of its own. A mask that matches nothing is an error, so
     * the agent hears it and writes a mask that holds something instead of leaving an empty card.
     */
    async create(ctx: Context, agentId: string, input: SliceCreateInput): Promise<SliceCreated> {
        if (!Value.Check(cuid2Schema, agentId)) {
            throw new SliceError("invalid_request", "The slice author is not a valid agent.");
        }
        if (!Value.Check(sliceCreateInputSchema, input)) {
            throw new SliceError("invalid_request", "The slice does not fit its bounds.");
        }
        const title = input.title.trim();
        if (title.length === 0) throw new SliceError("invalid_request", "A slice needs a title.");
        const note = input.note?.trim();
        const include = (input.include ?? []).map((rule) => rule.trim()).filter(Boolean);
        const exclude = (input.exclude ?? []).map((rule) => rule.trim()).filter(Boolean);
        const seen = new Set<string>();
        const paths = (input.paths ?? []).map((pinned) => {
            if (seen.has(pinned.path)) {
                throw new SliceError(
                    "invalid_request",
                    `Slice path "${pinned.path}" is listed more than once.`,
                );
            }
            seen.add(pinned.path);
            const reason = pinned.reason?.trim();
            return {
                path: pinned.path,
                ...(reason === undefined || reason.length === 0 ? {} : { reason }),
                lines: (pinned.lines ?? []).map((range) => ({
                    start: range.start,
                    end: range.end,
                })),
            };
        });
        const { workspaceId, root } = await this.#workspaceForAgent(ctx, agentId);
        let match;
        try {
            match = await this.#files.match(root, {
                source: input.source,
                include,
                exclude,
                paths,
                limit: MAX_SLICE_LISTED_FILES,
            });
        } catch (error) {
            if (error instanceof ProjectFileError) {
                throw new SliceError("invalid_request", error.message);
            }
            throw error;
        }
        if (match.total === 0) {
            const unmatched =
                match.unmatchedRules.length === 0
                    ? ""
                    : ` Nothing matched: ${match.unmatchedRules.join(", ")}.`;
            throw new SliceError(
                "invalid_request",
                `The slice "${title}" holds no files over ${input.source === "changes" ? "the changed files" : "the workspace"}.${unmatched}`,
            );
        }
        const presentation: SlicePresentation = {
            type: "slice",
            workspaceId,
            root: root.root,
            title,
            ...(note === undefined || note.length === 0 ? {} : { note }),
            source: input.source,
            include,
            exclude,
            paths,
            fileCount: match.total,
        };
        if (!Value.Check(slicePresentationSchema, presentation)) {
            throw new SliceError("invalid_request", "The slice does not fit its bounds.");
        }
        return {
            presentation,
            files: match.files,
            truncated: match.truncated,
            unmatchedRules: match.unmatchedRules,
        };
    }

    async #workspaceForAgent(
        ctx: Context,
        agentId: string,
    ): Promise<{ readonly workspaceId: string; readonly root: ProjectFileRoot }> {
        const agents = this.#requireAgents();
        const visited = new Set<string>();
        let current: string | null = agentId;
        while (current !== null) {
            if (visited.has(current) || visited.size >= 64) {
                throw new SliceError(
                    "invalid_request",
                    "The agent's ancestry is invalid or too deep.",
                );
            }
            visited.add(current);
            const bot = await this.#bots.forAgent(ctx, current);
            if (bot !== undefined) {
                if (bot.status !== "active") {
                    throw new SliceError("unavailable", "The bot workspace is not available.");
                }
                return {
                    workspaceId: bot.workspaceId,
                    root: await this.#files.resolveBotRoot(ctx, bot.workspaceId),
                };
            }
            if (this.#config.configuration.values.features.workspaces) {
                const workspaceId = await this.#workspaces.workspaceForAgent(ctx, current);
                if (workspaceId !== undefined) {
                    const workspace = await this.#workspaces.get(ctx, workspaceId);
                    if (workspace?.status !== "ready") {
                        throw new SliceError("unavailable", "The workspace is not ready.");
                    }
                    return {
                        workspaceId,
                        root: await this.#files.resolveRoot(ctx, workspace.projectRef, workspaceId),
                    };
                }
            }
            const project = await this.#projects.projectForAgent(ctx, current);
            if (project !== undefined) {
                if (project.status !== "active" || project.initializationStatus !== "ready") {
                    throw new SliceError("unavailable", "The project root is not ready.");
                }
                return {
                    workspaceId: project.id,
                    root: await this.#files.resolveRoot(ctx, project.id),
                };
            }
            current = await agents.parentOf(ctx, current);
        }
        throw new SliceError("not_found", "This agent does not belong to a workspace.");
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) throw new Error("The slices module has not started.");
        return this.#agents;
    }
}
