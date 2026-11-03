import { describe, expect, it } from "vitest";
import { formatSurfaceChatPrompt } from "../../sources/surfaces/impl/formatSurfaceChatPrompt.js";
import { SURFACE_REFERENCE_INSTRUCTIONS } from "../../sources/surfaces/impl/surfaceReferenceInstructions.js";
import { surfaceTools } from "../../sources/surfaces/tools/surfaceTools.js";

const id = "s4k8m2q9w1e5r7y3u6i0o2p4";
const prompt = (type: string, name = "Errands") => formatSurfaceChatPrompt({ id, type, name });
/** Tools other modules own; the chat prompt points at them for reference Tabs. */
const OTHER_MODULE_TOOLS = new Set([
    "read_artifact",
    "read_artifact_file",
    "list_bots",
    "send_bot_message",
    "list_tasks",
    "send_task_message",
    "read_agent_history",
    // Specified for chat Tabs in API.md.
    "list_tab_messages",
    "list_tab_message_versions",
]);
const TYPES = [
    "todo",
    "document",
    "calendar",
    "chat",
    "artifact",
    "system_monitor",
    "bot",
    "task",
] as const;

describe("Tab chat prompt", () => {
    it.each(TYPES)("places a %s chat on its Tab and keeps it focused there", (type) => {
        const text = prompt(type);
        expect(text).toMatch(/^# Tab chat\n/);
        expect(text).toContain("side chat of the ");
        expect(text).toContain('"Errands"');
        expect(text).toContain(`- Tab ID: \`${id}\``);
        expect(text).toContain(`- Tab type: \`${type}\``);
        expect(text).toContain("work for whoever sent the current message");
        expect(text).toContain("## Read the current state first");
        expect(text).toContain("## Stay focused");
        expect(text).toContain("You cannot create Tabs or change who has joined one");
    });

    it.each([
        ["todo", "Call list_todos with this Tab ID", "status completed"],
        ["document", "Call read_document with this Tab ID", "the seq from that read"],
        ["calendar", "Call list_calendar_events with this Tab ID", "changes the whole series"],
        ["chat", "Call list_tab_messages with this Tab ID", "cannot post, edit, or delete"],
        ["system_monitor", "Call read_system_monitor with this Tab ID", "It is read-only."],
        ["artifact", "read it with read_artifact", "artifact was deleted"],
        ["bot", "read_agent_history with that agent ID", "send_bot_message only when"],
        ["task", "read_agent_history with that agent ID", "send_task_message only when"],
    ])("tells a %s chat how to read it and how to work on it", (type, read, rule) => {
        const text = prompt(type);
        expect(text).toContain(read);
        expect(text).toContain(rule);
    });

    it("names only tools that exist and never administration", () => {
        const names = new Set(
            surfaceTools({} as never, { agent: { id: "chat" } } as never, false).map(
                (tool) => tool.name,
            ),
        );
        const admin = surfaceTools({} as never, { agent: { id: "chat" } } as never, true)
            .map((tool) => tool.name)
            .filter((name) => !names.has(name));
        for (const type of TYPES) {
            for (const [token] of prompt(type).matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) {
                if (token === type) continue;
                expect(names.has(token) || OTHER_MODULE_TOOLS.has(token), token).toBe(true);
                expect(admin).not.toContain(token);
            }
        }
    });

    it("calls calendars and conversations what the specification names them", () => {
        expect(prompt("calendar")).toContain('side chat of the shared calendar "Errands"');
        expect(prompt("chat")).toContain("This Tab is a conversation among people.");
    });

    it("reads an unknown type's Tab through the catalog", () => {
        const text = prompt("whiteboard", "Ideas");
        expect(text).toContain('side chat of the whiteboard Tab "Ideas"');
        expect(text).toContain("Page through list_tabs until you find this Tab ID");
        expect(text).not.toContain("## Working");
    });
});

describe("Tab reference instructions", () => {
    it("tell agents to mention a Tab by link, with the ID its tools take", () => {
        expect(SURFACE_REFERENCE_INSTRUCTIONS).toContain("[its name](happy://tabs/<tabId>)");
        expect(SURFACE_REFERENCE_INSTRUCTIONS).toContain("tabId");
        const names = new Set(
            surfaceTools({} as never, { agent: { id: "any" } } as never, false).map(
                (tool) => tool.name,
            ),
        );
        const named = [...SURFACE_REFERENCE_INSTRUCTIONS.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map(
            ([token]) => token,
        );
        expect(named).toEqual(["list_tabs", "list_todos", "read_document", "list_calendar_events"]);
        for (const token of named) expect(names.has(token), token).toBe(true);
    });
});
