import { describe, expect, it } from "vitest";

import { apiAssistantIdentityForProviderEvent } from "../../sources/api/ApiModule.js";

describe("API assistant streaming identity", () => {
    it("anchors every event after block start to the in-flight segment", () => {
        const started = apiAssistantIdentityForProviderEvent("block_start", "run-one", undefined);

        for (const eventType of ["text_delta", "text_end", "block_stop", "block_reset"]) {
            expect(apiAssistantIdentityForProviderEvent(eventType, "run-two", started)).toEqual(
                started,
            );
        }

        const next = apiAssistantIdentityForProviderEvent("block_start", "run-two", started);
        expect(next.runId).toBe("run-two");
        expect(next.messageId).not.toBe(started.messageId);
    });
});
