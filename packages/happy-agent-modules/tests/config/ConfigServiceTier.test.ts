import { describe, expect, it } from "vitest";
import { parseHappyAgentConfigToml } from "../../sources/config/index.js";

describe("inference speed preferences", () => {
    it.each(["fast", "ultrafast"])("preserves the %s preference", (speed) => {
        expect(
            parseHappyAgentConfigToml(`[defaults]\nservice_tier = "${speed}"`).values.defaults
                ?.service_tier,
        ).toBe(speed);
    });
});
