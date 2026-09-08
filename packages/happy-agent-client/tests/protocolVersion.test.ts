import { describe, expect, it } from "vitest";

import {
    HAPPY_AGENT_MIN_PROTOCOL_VERSION,
    HAPPY_AGENT_PROTOCOL_VERSION,
} from "../sources/protocol/daemon.js";

describe("Happy Agent protocol version", () => {
    it("marks unnamed bot creation with protocol 24", () => {
        expect(HAPPY_AGENT_PROTOCOL_VERSION).toBe(24);
    });

    it("keeps the additive compatibility range rooted at protocol 22", () => {
        expect(HAPPY_AGENT_MIN_PROTOCOL_VERSION).toBe(22);
    });
});
