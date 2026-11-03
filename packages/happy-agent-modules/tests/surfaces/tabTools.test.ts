import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { surfaceTools } from "../../sources/surfaces/tools/surfaceTools.js";
import { SURFACE_REFERENCE_INSTRUCTIONS } from "../../sources/surfaces/impl/surfaceReferenceInstructions.js";

describe("tab-only model contract", () => {
    const tools: readonly AnyAgentTool[] = surfaceTools(
        {} as never,
        { agent: { id: "admin" } } as never,
        true,
    );

    it.each(tools.map((tool) => [tool.name, tool] as const))(
        "%s advertises no surface aliases",
        (_name, tool) => {
            expect(
                JSON.stringify({
                    name: tool.name,
                    parameters: tool.parameters,
                    returnType: tool.returnType,
                    description: tool.description,
                    capabilities: tool.capabilities,
                    searchKeywords: tool.searchKeywords,
                }),
            ).not.toMatch(/surface/i);
            if (tool.parameters !== undefined && "tabId" in tool.parameters.properties) {
                expect(
                    Value.Check(tool.parameters, { surfaceId: "abcdefghijklmnopqrstuvwx" }),
                ).toBe(false);
            }
        },
    );

    it("prompts use the canonical tools and links", () => {
        expect(SURFACE_REFERENCE_INSTRUCTIONS).toContain("happy://tabs/<tabId>");
        expect(SURFACE_REFERENCE_INSTRUCTIONS).toContain("list_tabs");
        expect(SURFACE_REFERENCE_INSTRUCTIONS).not.toMatch(/surface/i);
    });

    it("projects persisted todo identities in lists and history without changing content", async () => {
        const todo = {
            surfaceId: "abcdefghijklmnopqrstuvwx",
            id: "todo",
            text: "surfaceId is user text",
        };
        const module = {
            listTodos: async () => [todo],
            versions: async () => ({
                versions: [{ todo, actor: { userId: null, agentId: null }, source: "api" }],
                nextAfterVersion: null,
            }),
        };
        const projected: readonly AnyAgentTool[] = surfaceTools(
            module as never,
            { agent: { id: "agent" } } as never,
            false,
        );
        const list = projected.find((tool) => tool.name === "list_todos")!;
        const history = projected.find((tool) => tool.name === "list_todo_versions")!;
        expect(await list.execute({} as never, { tabId: todo.surfaceId }, {} as never)).toEqual({
            todos: [{ tabId: todo.surfaceId, id: "todo", text: todo.text }],
            nextOffset: null,
        });
        expect(
            await history.execute(
                {} as never,
                { tabId: todo.surfaceId, todoId: "todo" },
                {} as never,
            ),
        ).toMatchObject({
            versions: [{ todo: { tabId: todo.surfaceId, id: "todo", text: todo.text } }],
        });
        expect(todo).toHaveProperty("surfaceId");
        expect(todo).not.toHaveProperty("tabId");
    });
});
