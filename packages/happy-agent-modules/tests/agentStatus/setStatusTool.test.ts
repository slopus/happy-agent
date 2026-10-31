import { withAgentPermissionMode, type AgentModuleScope } from "@slopus/happy-agent-base";
import { Value } from "@sinclair/typebox/value";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import type { AgentStatusModule } from "../../sources/agentStatus/AgentStatusModule.js";
import { setStatusTool } from "../../sources/agentStatus/tools/set_status.js";

/** The tool, with an agent status module that only records what it was asked to write. */
function statusTool() {
    const written: (string | null)[] = [];
    const status = {
        setStatus: async (_ctx: unknown, call: { readonly text: string | null }) => {
            written.push(call.text);
        },
    } as unknown as AgentStatusModule;
    const scope = { agent: { id: "agentstatus" } } as unknown as AgentModuleScope;
    return { tool: setStatusTool(status, scope), written };
}

describe("set_status", () => {
    const { tool } = statusTool();
    const accepts = (text: string | null) => Value.Check(tool.parameters!, { text });

    it("accepts one line, two lines split by one line break, and null", () => {
        expect(accepts("Shipped to preview")).toBe(true);
        expect(accepts("1. Ship new onboarding\n2. Submit iOS native build")).toBe(true);
        expect(accepts("1. Ship new onboarding\r\n2. Submit iOS native build")).toBe(true);
        expect(accepts("● ● [●] ○ Testing payments")).toBe(true);
        expect(accepts(null)).toBe(true);
    });

    it("refuses more than one line break, empty lines, and other control characters", () => {
        expect(accepts("one\ntwo\nthree")).toBe(false);
        expect(accepts("one\r\ntwo\r\nthree")).toBe(false);
        expect(accepts("one\n")).toBe(false);
        expect(accepts("\ntwo")).toBe(false);
        expect(accepts("one\rtwo")).toBe(false);
        expect(accepts("one\n\rtwo")).toBe(false);
        expect(accepts("one\ttwo")).toBe(false);
        expect(accepts("one\u0000two")).toBe(false);
        expect(accepts("one\u007ftwo")).toBe(false);
        expect(accepts("")).toBe(false);
        expect(accepts("x".repeat(121))).toBe(false);
    });

    it("writes a \\r\\n line break as \\n", async () => {
        const { tool, written } = statusTool();
        const ctx = withAgentPermissionMode(createRootContext().named("set-status-test"), "auto");
        const result = await tool.execute(
            ctx,
            { text: "1. Ship new onboarding\r\n2. Submit iOS native build" },
            { id: "toolcall" } as never,
        );
        expect(written).toEqual(["1. Ship new onboarding\n2. Submit iOS native build"]);
        expect(result).toEqual({ text: "1. Ship new onboarding\n2. Submit iOS native build" });
    });
});
