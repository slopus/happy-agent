import { describe, expect, it } from "vitest";

import {
    normalizeQuickReply,
    quickRepliesProblems,
    redactUiValue,
    uiActionDefinition,
    uiActionPermission,
    uiComponents,
} from "../sources/index.js";

describe("chat UI bundles", () => {
    it("leaves undeclared fields and secrets out of a stored payload", () => {
        const found = uiActionDefinition("provider_sign_in.submit_token")!;
        expect(
            redactUiValue(found.definition.payload, { token: "sk-ant-oat01-x", smuggled: "y" }),
        ).toEqual({});
    });

    it("chooses a sign-in's permission by its target", () => {
        const signIn = uiActionDefinition("provider_sign_in.sign_in")!.definition;
        expect(uiActionPermission(signIn, { provider: "claude", target: "team" })).toBe(
            "providers.manage",
        );
        expect(uiActionPermission(signIn, { provider: "claude" })).toBe("providers.own");
    });
});

describe("quick replies", () => {
    it("collapses whitespace and checks 1 to 6 unique plain options", () => {
        expect(normalizeQuickReply("  Fix   the\tlogin \n")).toBe("Fix the login");
        expect(quickRepliesProblems(["Yes", "Not now"])).toEqual([]);
        expect(quickRepliesProblems([])).toEqual(["Suggest 1 to 6 replies."]);
        expect(quickRepliesProblems(["Same", "Same"])).toEqual([
            'Replies must be unique; "Same" repeats.',
        ]);
        expect(quickRepliesProblems(["x".repeat(201)])).toHaveLength(1);
        expect(quickRepliesProblems(["right-to-left \u202e"])).toHaveLength(1);
    });
});
