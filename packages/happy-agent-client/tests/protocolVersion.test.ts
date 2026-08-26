import { describe, expect, it } from "vitest";

import { HAPPY_AGENT_PROTOCOL_VERSION } from "../sources/protocol/daemon.js";

describe("Happy Agent protocol version", () => {
    it("matches the protocol-23 API contract", () => {
        expect(HAPPY_AGENT_PROTOCOL_VERSION).toBe(23);
    });
});
