import { Value } from "@sinclair/typebox/value";
import { expect, it } from "vitest";

import { botSchema } from "../sources/protocol/bots.js";
import { taskSchema } from "../sources/protocol/tasks.js";

it("carries an optional generated short name on tasks and bots", () => {
    for (const schema of [taskSchema, botSchema]) {
        expect(schema.required).not.toContain("shortName");
        expect(Value.Check(schema.properties.shortName, "Onboarding 🚀")).toBe(true);
        expect(Value.Check(schema.properties.shortName, "")).toBe(false);
    }
});
