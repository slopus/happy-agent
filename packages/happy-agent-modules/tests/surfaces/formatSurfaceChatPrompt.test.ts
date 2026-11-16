import { describe, expect, it } from "vitest";
import { formatSurfaceChatPrompt } from "../../sources/surfaces/impl/formatSurfaceChatPrompt.js";
import { SURFACE_REFERENCE_INSTRUCTIONS } from "../../sources/surfaces/impl/surfaceReferenceInstructions.js";
import { surfaceTools } from "../../sources/surfaces/tools/surfaceTools.js";

const id = "s4k8m2q9w1e5r7y3u6i0o2p4";
const prompt = (type: string, name = "Errands") => formatSurfaceChatPrompt({ id, type, name });
/** Tools other modules own; the chat prompt points at them for reference Surfaces. */
const OTHER_MODULE_TOOLS = new Set([
    "read_artifact",
    "read_artifact_file",
    "list_bots",
    "send_bot_message",
    "list_tasks",
    "send_task_message",
    "read_agent_history",
    // Specified for chat Surfaces in API.md.
    "list_surface_messages",
    "list_surface_message_versions",
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

describe("Surface chat prompt", () => {
    it.each(TYPES)("places a %s chat on its Surface and keeps it focused there", (type) => {
        const text = prompt(type);
        expect(text).toMatch(/^# Surface chat\n/);
        expect(text).toContain("side chat of the ");
        expect(text).toContain('"Errands"');
        expect(text).toContain(`- Surface ID: \`${id}\``);
        expect(text).toContain(`- Surface type: \`${type}\``);
        expect(text).toContain("work for whoever sent the current message");
        expect(text).toContain("## Read the current state first");
        expect(text).toContain("## Stay focused");
        expect(text).toContain("You cannot create Surfaces or change who has joined one");
    });

    it.each([
        ["todo", "Call list_todos with this Surface ID", "status completed"],
        ["document", "Call read_document with this Surface ID", "the seq from that read"],
        ["calendar", "Call list_calendar_events with this Surface ID", "changes the whole series"],
        ["chat", "Call list_surface_messages with this Surface ID", "cannot post, edit, or delete"],
        ["system_monitor", "Call read_system_monitor with this Surface ID", "It is read-only."],
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
        expect(prompt("chat")).toContain("This Surface is a conversation among people.");
    });

    it("reads an unknown type's Surface through the catalog", () => {
        const text = prompt("whiteboard", "Ideas");
        expect(text).toContain('side chat of the whiteboard Surface "Ideas"');
        expect(text).toContain("Page through list_surfaces until you find this Surface ID");
        expect(text).not.toContain("## Working");
    });
});

describe("Surface reference instructions", () => {
    it("tell agents to mention a Surface by link, with the ID its tools take", () => {
        expect(SURFACE_REFERENCE_INSTRUCTIONS).toContain(
            "[its name](happy://surfaces/<surfaceId>)",
        );
        expect(SURFACE_REFERENCE_INSTRUCTIONS).toContain("surfaceId");
        const names = new Set(
            surfaceTools({} as never, { agent: { id: "any" } } as never, false).map(
                (tool) => tool.name,
            ),
        );
        const named = [...SURFACE_REFERENCE_INSTRUCTIONS.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map(
            ([token]) => token,
        );
        expect(named).toEqual([
            "list_surfaces",
            "list_todos",
            "read_document",
            "list_calendar_events",
        ]);
        for (const token of named) expect(names.has(token), token).toBe(true);
    });
});
