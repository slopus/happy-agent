import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { posix } from "node:path";

import {
    parseCodexPatch,
    type CodexPatchHunk,
    type CodexPatchOperation,
} from "../impl/parseCodexPatch.js";

const nonEmptyString = Type.String({ minLength: 1 });

const applyPatchArgumentsSchema = Type.Object(
    {
        patch: nonEmptyString,
        workdir: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
);

const execCommandArgumentsSchema = Type.Object(
    {
        cmd: nonEmptyString,
        workdir: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
);

const commandArgumentsSchema = Type.Object(
    { command: nonEmptyString },
    { additionalProperties: true },
);

const readFileArgumentsSchema = Type.Object(
    { target_file: nonEmptyString },
    { additionalProperties: true },
);

const viewImageArgumentsSchema = Type.Object(
    { path: nonEmptyString },
    { additionalProperties: true },
);

const listDirectoryArgumentsSchema = Type.Object(
    { target_directory: nonEmptyString },
    { additionalProperties: true },
);

const writeArgumentsSchema = Type.Object(
    {
        content: Type.String(),
        file_path: nonEmptyString,
    },
    { additionalProperties: true },
);

const editArgumentsSchema = Type.Object(
    {
        file_path: nonEmptyString,
        new_string: Type.String(),
        old_string: Type.String(),
        replace_all: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: true },
);

const queryArgumentsSchema = Type.Object(
    {
        query: nonEmptyString,
        allowed_domains: Type.Optional(Type.Array(Type.String())),
        blocked_domains: Type.Optional(Type.Array(Type.String())),
        domains: Type.Optional(Type.Array(Type.String())),
        include_domains: Type.Optional(Type.Array(Type.String())),
        latest: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: true },
);

const workflowArgumentsSchema = Type.Object(
    {
        input: Type.Object(
            {
                description: Type.Optional(nonEmptyString),
                name: Type.Optional(nonEmptyString),
                scriptPath: Type.Optional(nonEmptyString),
            },
            { additionalProperties: true },
        ),
    },
    { additionalProperties: true },
);

const displayArgumentsSchema = Type.Object(
    {
        agent_id: Type.Optional(nonEmptyString),
        ask_id: Type.Optional(nonEmptyString),
        at: Type.Optional(Type.Union([Type.String(), Type.Number()])),
        bash_id: Type.Optional(nonEmptyString),
        chars: Type.Optional(Type.String()),
        command: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        id: Type.Optional(nonEmptyString),
        input: Type.Optional(Type.Unknown()),
        name: Type.Optional(Type.String()),
        objective: Type.Optional(Type.String()),
        path: Type.Optional(Type.String()),
        pattern: Type.Optional(Type.String()),
        presenceId: Type.Optional(Type.String()),
        query: Type.Optional(Type.String()),
        requestId: Type.Optional(nonEmptyString),
        scheduleId: Type.Optional(nonEmptyString),
        secretId: Type.Optional(nonEmptyString),
        server: Type.Optional(nonEmptyString),
        session_id: Type.Optional(Type.Number()),
        status: Type.Optional(Type.String()),
        targetAgentId: Type.Optional(nonEmptyString),
        target: Type.Optional(nonEmptyString),
        task_id: Type.Optional(nonEmptyString),
        task_ids: Type.Optional(Type.Array(nonEmptyString)),
        title: Type.Optional(Type.String()),
        toAgentId: Type.Optional(nonEmptyString),
        tool: Type.Optional(Type.String()),
        url: Type.Optional(Type.String()),
        workspaceId: Type.Optional(nonEmptyString),
    },
    { additionalProperties: true },
);

const nestedDisplayArgumentsSchema = Type.Object(
    {
        agent_id: Type.Optional(nonEmptyString),
        ask_id: Type.Optional(nonEmptyString),
        id: Type.Optional(nonEmptyString),
        presenceId: Type.Optional(Type.String()),
        requestId: Type.Optional(nonEmptyString),
        status: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
);

const changesArgumentsSchema = Type.Object(
    { changes: Type.Record(Type.String(), Type.Unknown()) },
    { additionalProperties: true },
);

const filePathArgumentsSchema = Type.Object(
    { file_path: nonEmptyString },
    { additionalProperties: true },
);

const pathArgumentsSchema = Type.Object({ path: nonEmptyString }, { additionalProperties: true });

const patternArgumentsSchema = Type.Object(
    { pattern: nonEmptyString },
    { additionalProperties: true },
);

const urlArgumentsSchema = Type.Object({ url: nonEmptyString }, { additionalProperties: true });

const webSearchDisplayArgumentsSchema = Type.Object(
    {
        query: nonEmptyString,
        source: Type.Optional(Type.Literal("x")),
    },
    { additionalProperties: true },
);

const SEARCH_TOOL_NAMES = new Set([
    "bedrock_web_search",
    "claude_web_search",
    "codex_web_search",
    "gemini_web_search",
    "grok_web_search",
    "grok_x_search",
]);

export interface NormalizedHappyToolCall {
    readonly args: Record<string, unknown>;
    readonly name: string;
}

export interface HappyToolCallPresentation {
    readonly description: string;
    readonly title: string;
}

/**
 * Translate only when Happy mobile already has a renderer for the same operation and payload.
 * An unfamiliar tool is still a canonical session tool call; preserving its real name is more
 * useful than forcing it into a client shape that means something else.
 */
export function normalizeHappyToolCall(
    name: string,
    args: Record<string, unknown>,
): NormalizedHappyToolCall {
    if (name === "apply_patch" && Value.Check(applyPatchArgumentsSchema, args)) {
        try {
            const operations = parseCodexPatch(args.patch);
            return {
                name: "CodexPatch",
                args: { changes: mobilePatchChanges(operations, args.workdir) },
            };
        } catch {
            return { name, args };
        }
    }

    if (name === "exec_command" && Value.Check(execCommandArgumentsSchema, args)) {
        const { cmd, workdir, ...rest } = args;
        return {
            name: "CodexBash",
            args: {
                ...rest,
                command: cmd,
                ...(workdir === undefined ? {} : { cwd: workdir }),
            },
        };
    }

    if (name === "run_terminal_command" && Value.Check(commandArgumentsSchema, args)) {
        return { name: "Bash", args };
    }

    if (name === "read_file" && Value.Check(readFileArgumentsSchema, args)) {
        const { target_file, ...rest } = args;
        return { name: "Read", args: { ...rest, file_path: target_file } };
    }

    if (name === "view_image" && Value.Check(viewImageArgumentsSchema, args)) {
        const { path, ...rest } = args;
        return { name: "Read", args: { ...rest, file_path: path } };
    }

    if (name === "write" && Value.Check(writeArgumentsSchema, args)) {
        return { name: "Write", args };
    }
    if (name === "search_replace" && Value.Check(editArgumentsSchema, args)) {
        return { name: "Edit", args };
    }

    if (name === "list_dir" && Value.Check(listDirectoryArgumentsSchema, args)) {
        const { target_directory, ...rest } = args;
        return { name: "LS", args: { ...rest, path: target_directory } };
    }

    if (name === "grep" && Value.Check(patternArgumentsSchema, args)) {
        return { name: "Grep", args };
    }
    if (name === "web_fetch" && Value.Check(urlArgumentsSchema, args)) {
        return { name: "WebFetch", args };
    }

    if (SEARCH_TOOL_NAMES.has(name) && Value.Check(queryArgumentsSchema, args)) {
        const { domains, include_domains, ...rest } = args;
        const allowedDomains = args.allowed_domains ?? domains ?? include_domains;
        return {
            name: "WebSearch",
            args: {
                ...rest,
                ...(allowedDomains === undefined ? {} : { allowed_domains: allowedDomains }),
                ...(name === "grok_x_search" ? { source: "x" } : {}),
            },
        };
    }

    return { name, args };
}

/** The short activity text Happy mobile shows for a canonical session tool call. */
export function happyToolCallPresentation(
    originalName: string,
    normalized: NormalizedHappyToolCall,
): HappyToolCallPresentation {
    const { args, name } = normalized;
    const title = titleForCanonicalTool(name);
    const displayArgs = Value.Check(displayArgumentsSchema, args) ? args : undefined;

    if (name === "CodexPatch") {
        const fileCount = Value.Check(changesArgumentsSchema, args)
            ? Object.keys(args.changes).length
            : 0;
        return {
            title: "Apply patch",
            description:
                fileCount === 1
                    ? "Applying patch to 1 file"
                    : `Applying patch to ${String(fileCount)} files`,
        };
    }

    if (Value.Check(commandArgumentsSchema, args) && (name === "Bash" || name === "CodexBash")) {
        const purpose = concise(displayArgs?.description);
        return { title, description: purpose ?? `Running ${name}` };
    }

    if (Value.Check(filePathArgumentsSchema, args)) {
        if (name === "Read") return { title, description: `Reading ${args.file_path}` };
        if (name === "Edit") return { title, description: `Editing ${args.file_path}` };
        if (name === "Write") return { title, description: `Writing ${args.file_path}` };
    }

    if (name === "LS" && Value.Check(pathArgumentsSchema, args)) {
        return { title, description: `Listing ${args.path}` };
    }
    if ((name === "Glob" || name === "Grep") && Value.Check(patternArgumentsSchema, args)) {
        return { title, description: `Searching for ${concise(args.pattern) ?? args.pattern}` };
    }
    if (name === "WebFetch" && Value.Check(urlArgumentsSchema, args)) {
        return { title, description: `Fetching ${concise(args.url) ?? args.url}` };
    }
    if (name === "WebSearch" && Value.Check(webSearchDisplayArgumentsSchema, args)) {
        return {
            title,
            description: `${args.source === "x" ? "Searching X" : "Searching the web"} for ${concise(args.query) ?? args.query}`,
        };
    }
    if (originalName === "run_workflow" && Value.Check(workflowArgumentsSchema, args)) {
        const workflow = args.input.name ?? args.input.description ?? args.input.scriptPath;
        return {
            title,
            description:
                workflow === undefined
                    ? "Starting a background workflow"
                    : `Starting workflow ${concise(workflow) ?? workflow}`,
        };
    }

    if (displayArgs === undefined) {
        return { title, description: `Running ${title}` };
    }

    const exact = exactToolDescription(originalName, displayArgs);
    return { title, description: exact ?? `Running ${title}` };
}

function exactToolDescription(
    name: string,
    args: typeof displayArgumentsSchema.static,
): string | undefined {
    switch (name) {
        case "BashInput":
            return args.bash_id === undefined
                ? "Sending input to a background shell"
                : `Sending input to shell ${args.bash_id}`;
        case "BashOutput":
            return args.bash_id === undefined
                ? "Reading background shell output"
                : `Reading output from shell ${args.bash_id}`;
        case "BashStop":
            return args.bash_id === undefined
                ? "Stopping a background shell"
                : `Stopping shell ${args.bash_id}`;
        case "write_stdin":
            return args.session_id === undefined
                ? "Sending input to a shell session"
                : args.chars === undefined || args.chars.length === 0
                  ? `Waiting for shell session ${String(args.session_id)}`
                  : `Sending input to shell session ${String(args.session_id)}`;
        case "kill_session":
            return args.session_id === undefined
                ? "Stopping a shell session"
                : `Stopping shell session ${String(args.session_id)}`;
        case "get_command_or_subagent_output":
            return args.task_ids === undefined
                ? "Reading background command output"
                : `Reading output from ${String(args.task_ids.length)} background command${args.task_ids.length === 1 ? "" : "s"}`;
        case "send_command_input":
            return targetDescription("Sending input to", args.task_id);
        case "kill_command_or_subagent":
            return targetDescription("Stopping background command", args.task_id);
        case "create_agent":
            return namedDescription("Starting collaborator", args.title);
        case "send_agent_message":
            return targetDescription("Sending a message to", args.toAgentId);
        case "interrupt_agent":
            return targetDescription("Interrupting", args.targetAgentId);
        case "read_agent_history":
            return targetDescription("Reading history for", args.target ?? args.agent_id);
        case "create_goal":
            return namedDescription("Creating goal", args.objective);
        case "get_goal":
            return "Checking the current goal";
        case "update_goal":
            return namedDescription("Updating goal", args.status);
        case "clear_goal":
            return "Clearing the current goal";
        case "create_task":
            return namedDescription("Creating task", args.title);
        case "list_tasks":
            return "Listing tasks";
        case "get_task":
            return targetDescription("Reading task", args.id);
        case "update_task":
            return targetDescription("Updating task", args.id);
        case "complete_task":
            return targetDescription("Completing task", args.id);
        case "remove_task":
            return targetDescription("Removing task", args.id);
        case "get_usage":
            return "Reading token usage";
        case "get_agent_tree_usage":
            return "Reading agent-tree usage";
        default:
            return workspaceAndServiceDescription(name, args);
    }
}

function workspaceAndServiceDescription(
    name: string,
    args: typeof displayArgumentsSchema.static,
): string | undefined {
    const nested = Value.Check(nestedDisplayArgumentsSchema, args.input) ? args.input : undefined;
    switch (name) {
        case "list_projects":
            return "Listing projects";
        case "create_child_workspace":
        case "create_workspace":
            return namedDescription("Creating workspace", args.name);
        case "list_workspaces":
            return "Listing workspaces";
        case "get_workspace":
            return targetDescription("Reading workspace", args.workspaceId);
        case "rename_workspace":
            return namedDescription("Renaming workspace", args.name);
        case "archive_workspace":
            return targetDescription("Archiving workspace", args.workspaceId);
        case "get_workspace_branch_metadata":
            return targetDescription("Reading branch metadata for", args.workspaceId);
        case "list_secrets":
            return "Listing available secret references";
        case "reference_secret":
            return targetDescription("Reading secret reference", args.id);
        case "attach_secret":
            return targetDescription("Attaching secret", args.secretId);
        case "detach_secret":
            return targetDescription("Detaching secret", args.secretId);
        case "list_workflows":
            return "Listing workflows";
        case "workflow_status":
            return targetDescription("Checking workflow", args.id);
        case "cancel_workflow":
            return targetDescription("Stopping workflow", args.id);
        case "resume_workflow":
            return targetDescription("Resuming workflow", args.id);
        case "wait_workflow":
            return targetDescription("Waiting for workflow", args.id);
        case "workflow_logs":
            return targetDescription("Reading workflow logs for", args.id ?? nested?.id);
        case "wait":
            return "Waiting";
        case "wait_until":
            return namedDescription("Waiting until", formatScalar(args.at));
        case "schedule_message":
            return targetDescription("Scheduling a message for", args.agent_id ?? nested?.agent_id);
        case "list_scheduled_messages":
            return "Listing scheduled messages";
        case "cancel_scheduled_message":
            return targetDescription("Cancelling scheduled message", args.scheduleId);
        case "request_user_input":
            return "Waiting for your answer";
        case "cancel_ask":
            return targetDescription(
                "Cancelling question",
                args.requestId ?? args.ask_id ?? nested?.requestId ?? nested?.ask_id,
            );
        case "get_presence":
            return "Checking your presence";
        case "list_presences":
            return "Listing presence states";
        case "set_presence":
            return namedDescription(
                "Setting presence",
                args.presenceId ?? args.status ?? nested?.presenceId ?? nested?.status,
            );
        case "list_skills":
            return "Listing skills";
        case "read_skill":
            return namedDescription("Reading skill", args.name);
        case "list_mcp_servers":
            return "Listing MCP servers";
        case "list_mcp_tools":
            return targetDescription("Listing MCP tools from", args.server);
        case "call_mcp_tool":
            return namedDescription("Calling MCP tool", args.name ?? args.tool);
        case "list_mcp_resources":
            return targetDescription("Listing MCP resources from", args.server);
        case "list_mcp_resource_templates":
            return targetDescription("Listing MCP resource templates from", args.server);
        case "read_mcp_resource":
            return targetDescription("Reading MCP resource from", args.server);
        case "list_mcp_prompts":
            return targetDescription("Listing MCP prompts from", args.server);
        case "get_mcp_prompt":
            return namedDescription("Reading MCP prompt", args.name);
        case "codex_imagegen":
        case "gemini_imagegen":
            return "Generating an image";
        case "gemini_generate_music":
            return "Generating music";
        case "gemini_analyze_media":
            return "Analyzing media";
        default:
            return undefined;
    }
}

function targetDescription(action: string, target: string | undefined): string {
    const value = concise(target);
    return value === undefined ? action : `${action} ${value}`;
}

function namedDescription(action: string, value: string | undefined): string {
    const text = concise(value);
    return text === undefined ? action : `${action}: ${text}`;
}

function concise(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const collapsed = value.trim().replaceAll(/\s+/gu, " ");
    if (collapsed.length === 0) return undefined;
    return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 119)}…`;
}

function formatScalar(value: string | number | undefined): string | undefined {
    return value === undefined ? undefined : String(value);
}

function titleForCanonicalTool(name: string): string {
    switch (name) {
        case "Bash":
        case "CodexBash":
            return "Terminal";
        case "LS":
            return "List Files";
        case "WebFetch":
            return "Fetch URL";
        case "WebSearch":
            return "Web Search";
        default:
            return humanizeToolName(name);
    }
}

function humanizeToolName(value: string): string {
    const spaced = value
        .replaceAll(/[_-]+/gu, " ")
        .replaceAll(/([a-z])([A-Z])/gu, "$1 $2")
        .trim();
    return spaced.length === 0
        ? "Tool"
        : spaced
              .split(/\s+/u)
              .map((part) => part[0]!.toUpperCase() + part.slice(1))
              .join(" ");
}

function mobilePatchChanges(
    operations: readonly CodexPatchOperation[],
    workdir: string | undefined,
): Record<string, unknown> {
    const changes: Record<string, unknown> = {};
    for (const operation of operations) {
        const path = mobilePatchPath(operation.path, workdir);
        if (operation.kind === "add") {
            changes[path] = {
                add: { content: operation.lines.join("\n") },
                kind: { move_path: null, type: "add" },
            };
            continue;
        }
        if (operation.kind === "delete") {
            changes[path] = { kind: { move_path: null, type: "delete" } };
            continue;
        }
        changes[path] = {
            diff: operation.hunks.map(mobilePatchHunk).join("\n"),
            kind: {
                move_path:
                    operation.moveTo === undefined
                        ? null
                        : mobilePatchPath(operation.moveTo, workdir),
                type: "update",
            },
        };
    }
    return changes;
}

function mobilePatchHunk(hunk: CodexPatchHunk): string {
    const oldLines = hunk.lines.filter((line) => line.marker !== "+").length;
    const newLines = hunk.lines.filter((line) => line.marker !== "-").length;
    const anchor = hunk.anchor === undefined ? "" : ` ${hunk.anchor}`;
    return [
        `@@ -1,${String(oldLines)} +1,${String(newLines)} @@${anchor}`,
        ...hunk.lines.map((line) => `${line.marker}${line.text}`),
    ].join("\n");
}

function mobilePatchPath(path: string, workdir: string | undefined): string {
    if (!workdir || workdir === "." || posix.isAbsolute(path)) return path;
    return posix.normalize(posix.join(workdir, path));
}
