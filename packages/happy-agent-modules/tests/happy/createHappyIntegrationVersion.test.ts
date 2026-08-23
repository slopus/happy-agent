import { describe, expect, it } from "vitest";

import { createHappyIntegrationVersion } from "../../sources/happy/createHappyIntegrationVersion.js";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("createHappyIntegrationVersion", () => {
    it("stays UUIDv7 and strictly ordered when time repeats or moves backward", () => {
        const first = createHappyIntegrationVersion(undefined, () => 1_000);
        const second = createHappyIntegrationVersion(first, () => 1_000);
        const third = createHappyIntegrationVersion(second, () => 999);

        expect(first).toMatch(UUID_V7_PATTERN);
        expect(second).toMatch(UUID_V7_PATTERN);
        expect(third).toMatch(UUID_V7_PATTERN);
        expect(second > first).toBe(true);
        expect(third > second).toBe(true);
    });

    it("rejects a previous value that is not UUIDv7", () => {
        expect(() => createHappyIntegrationVersion("not-a-version")).toThrow(
            "The Happy integration version is invalid.",
        );
    });
});
