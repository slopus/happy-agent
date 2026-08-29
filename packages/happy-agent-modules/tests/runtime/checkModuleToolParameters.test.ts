import type {
    AgentModule,
    AgentModuleScope,
    AgentSystemRef,
    AgentToolsOverride,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { createRootContext } from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { describe, expect, it } from "vitest";

import {
    checkModuleToolParameters,
    isObjectRooted,
} from "../../sources/runtime/checkModuleToolParameters.js";

describe("isObjectRooted", () => {
    it("accepts an absent schema and an object schema", () => {
        expect(isObjectRooted(undefined)).toBe(true);
        expect(isObjectRooted({ type: "object" })).toBe(true);
    });

    it("rejects provider-incompatible root schemas", () => {
        expect(isObjectRooted({ type: "array" })).toBe(false);
        expect(isObjectRooted({ anyOf: [{ type: "object" }] })).toBe(false);
        expect(isObjectRooted(null)).toBe(false);
    });

    it("validates the final array returned by an overrideTools hook", async () => {
        const invalid = defineAgentTool({
            name: "invalid",
            parameters: Type.String(),
            returnType: Type.Null(),
            shouldReviewInAutoMode: () => false,
            execute: async () => null,
            toLLM: () => [],
        });
        const module: AgentModule<AnyAgentTool, LibSQLDatabase> = {
            name: "override",
            beforeStart: () => ({ overrideTools: () => [invalid] }),
        };
        const hooks = await checkModuleToolParameters(module).beforeStart?.(
            createRootContext(),
            {} as AgentSystemRef<LibSQLDatabase>,
        );
        const input: AgentToolsOverride = {
            selection: {
                provider: "scripted",
                providerKind: "gym",
                model: undefined,
                effort: undefined,
                tier: undefined,
            },
            contributions: [],
            tools: [],
        };

        await expect(
            hooks?.overrideTools?.(
                createRootContext(),
                {} as AgentModuleScope<LibSQLDatabase>,
                input,
            ),
        ).rejects.toThrow("invalid");
    });
});
