import { describe, expect, it } from "vitest";

import {
    happyToolCallPresentation,
    normalizeHappyToolCall,
} from "../../sources/happy/normalizeHappyToolCall.js";

describe("Happy mobile tool-call normalization", () => {
    it.each([
        {
            source: "exec_command",
            input: { cmd: "pnpm test", workdir: "packages/app", yield_time_ms: 1_000 },
            name: "CodexBash",
            args: { command: "pnpm test", cwd: "packages/app", yield_time_ms: 1_000 },
        },
        {
            source: "run_terminal_command",
            input: { command: "git status", description: "Checking the worktree" },
            name: "Bash",
            args: { command: "git status", description: "Checking the worktree" },
        },
        {
            source: "read_file",
            input: { target_file: "src/app.ts", offset: 4, limit: 20 },
            name: "Read",
            args: { file_path: "src/app.ts", offset: 4, limit: 20 },
        },
        {
            source: "view_image",
            input: { path: "art/result.png", detail: "original" },
            name: "Read",
            args: { file_path: "art/result.png", detail: "original" },
        },
        {
            source: "write",
            input: { file_path: "src/app.ts", content: "hello" },
            name: "Write",
            args: { file_path: "src/app.ts", content: "hello" },
        },
        {
            source: "search_replace",
            input: { file_path: "src/app.ts", old_string: "a", new_string: "b" },
            name: "Edit",
            args: { file_path: "src/app.ts", old_string: "a", new_string: "b" },
        },
        {
            source: "list_dir",
            input: { target_directory: "src" },
            name: "LS",
            args: { path: "src" },
        },
        {
            source: "grep",
            input: { pattern: "tool-call", path: "src" },
            name: "Grep",
            args: { pattern: "tool-call", path: "src" },
        },
        {
            source: "web_fetch",
            input: { url: "https://happy.engineering", maxCharacters: 4_000 },
            name: "WebFetch",
            args: { url: "https://happy.engineering", maxCharacters: 4_000 },
        },
        {
            source: "claude_web_search",
            input: { query: "Happy", allowed_domains: ["happy.engineering"] },
            name: "WebSearch",
            args: { query: "Happy", allowed_domains: ["happy.engineering"] },
        },
        {
            source: "codex_web_search",
            input: { query: "Happy", domains: ["happy.engineering"] },
            name: "WebSearch",
            args: { query: "Happy", allowed_domains: ["happy.engineering"] },
        },
        {
            source: "grok_web_search",
            input: { query: "Happy", include_domains: ["happy.engineering"] },
            name: "WebSearch",
            args: { query: "Happy", allowed_domains: ["happy.engineering"] },
        },
        {
            source: "grok_x_search",
            input: { query: "Happy", latest: true },
            name: "WebSearch",
            args: { query: "Happy", latest: true, source: "x" },
        },
        {
            source: "bedrock_web_search",
            input: { query: "Happy" },
            name: "WebSearch",
            args: { query: "Happy" },
        },
        {
            source: "gemini_web_search",
            input: { query: "Happy" },
            name: "WebSearch",
            args: { query: "Happy" },
        },
    ])("maps $source to the existing $name client contract", ({ source, input, name, args }) => {
        expect(normalizeHappyToolCall(source, input)).toEqual({ name, args });
    });

    it.each([
        ["Bash", { command: "pnpm test" }],
        ["Read", { file_path: "README.md" }],
        ["Edit", { file_path: "README.md", old_string: "a", new_string: "b" }],
        ["Write", { file_path: "README.md", content: "hello" }],
        ["Glob", { pattern: "**/*.ts" }],
        ["Grep", { pattern: "hello" }],
        ["request_user_input", { question: "Ship it?" }],
        ["mcp__linear__create_issue", { title: "Bug" }],
    ])("preserves already canonical %s calls", (name, args) => {
        expect(normalizeHappyToolCall(name, args)).toEqual({ name, args });
    });

    it.each([
        ["exec_command", { workdir: "." }],
        ["read_file", { path: "README.md" }],
        ["write", { file_path: "README.md" }],
        ["search_replace", { file_path: "README.md", old_string: "a" }],
        ["list_dir", { path: "." }],
        ["grep", { path: "." }],
        ["web_fetch", { maxCharacters: 1_000 }],
        ["codex_web_search", { domains: ["example.com"] }],
    ])("keeps malformed %s calls intact for the generic renderer", (name, args) => {
        expect(normalizeHappyToolCall(name, args)).toEqual({ name, args });
    });

    it.each([
        ["BashInput", { bash_id: "bash-7", input: "yes\n" }, "Sending input to shell bash-7"],
        ["BashOutput", { bash_id: "bash-7" }, "Reading output from shell bash-7"],
        ["BashStop", { bash_id: "bash-7" }, "Stopping shell bash-7"],
        ["write_stdin", { session_id: 7 }, "Waiting for shell session 7"],
        ["kill_session", { session_id: 7 }, "Stopping shell session 7"],
        ["create_agent", { title: "Review auth" }, "Starting collaborator: Review auth"],
        ["send_agent_message", { toAgentId: "agent42" }, "Sending a message to agent42"],
        ["interrupt_agent", { targetAgentId: "agent42" }, "Interrupting agent42"],
        ["create_task", { title: "Fix sync" }, "Creating task: Fix sync"],
        ["complete_task", { id: "task-7" }, "Completing task task-7"],
        ["create_workspace", { name: "Patch sync" }, "Creating workspace: Patch sync"],
        ["workflow_status", { id: "workflow-7" }, "Checking workflow workflow-7"],
        [
            "workflow_logs",
            { input: { id: "workflow-7", from: "end" } },
            "Reading workflow logs for workflow-7",
        ],
        [
            "schedule_message",
            { input: { agent_id: "agent42", message: "Check it", in: "10m" } },
            "Scheduling a message for agent42",
        ],
        ["set_presence", { input: { status: "away", message: "Lunch" } }, "Setting presence: away"],
        ["read_skill", { name: "sessions" }, "Reading skill: sessions"],
        [
            "call_mcp_tool",
            { server: "linear", name: "create_issue" },
            "Calling MCP tool: create_issue",
        ],
    ])("gives generic %s rows exact user-visible context", (name, args, description) => {
        const normalized = normalizeHappyToolCall(name, args);
        expect(happyToolCallPresentation(name, normalized).description).toBe(description);
    });

    it.each([
        ["exec_command", { cmd: "pnpm test" }, "CodexBash", "Running CodexBash"],
        [
            "run_terminal_command",
            { command: "git status", description: "Checking Git" },
            "Bash",
            "Checking Git",
        ],
        ["read_file", { target_file: "src/app.ts" }, "Read", "Reading src/app.ts"],
        [
            "search_replace",
            { file_path: "src/app.ts", old_string: "a", new_string: "b" },
            "Edit",
            "Editing src/app.ts",
        ],
        ["grok_x_search", { query: "Happy" }, "WebSearch", "Searching X for Happy"],
    ])(
        "describes normalized %s as the client-native activity",
        (source, args, name, description) => {
            const normalized = normalizeHappyToolCall(source, args);
            expect(normalized.name).toBe(name);
            expect(happyToolCallPresentation(source, normalized).description).toBe(description);
        },
    );
});
