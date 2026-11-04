import { describe, expect, it } from "vitest";

import {
    CLAUDE_CODE_TELEMETRY_ENVIRONMENT,
    CLAUDE_SDK_PRIVACY_ENVIRONMENT,
} from "@/vendors/claude/claudeSdkPrivacyEnvironment.js";

describe("Claude Code privacy environment", () => {
    it("lifts only the two switches that hide the account's models when telemetry is allowed", () => {
        expect(CLAUDE_SDK_PRIVACY_ENVIRONMENT).toMatchObject({
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_TELEMETRY: "1",
        });
        const {
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: _nonessential,
            DISABLE_TELEMETRY: _telemetry,
            ...rest
        } = CLAUDE_SDK_PRIVACY_ENVIRONMENT;
        expect(CLAUDE_CODE_TELEMETRY_ENVIRONMENT).toEqual(rest);
    });
});
