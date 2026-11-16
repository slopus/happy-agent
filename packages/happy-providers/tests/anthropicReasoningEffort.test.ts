import { expect, it } from "vitest";

import { createAnthropicRequest } from "@/protocol/anthropic/createAnthropicRequest.js";
import { toClaudeSdkOptions } from "@/vendors/claude/impl/toClaudeSdkOptions.js";

const options = {
    context: { instructions: "Test instructions.", messages: [] },
    model: "claude-fable-5-2",
    tools: [],
};

it("rejects Ultra for Anthropic instead of sending or downgrading it", () => {
    expect(() => createAnthropicRequest({ ...options, effort: "ultra" })).toThrow(
        "Anthropic does not support Ultra reasoning effort.",
    );
});

it("keeps Anthropic max effort unchanged", () => {
    expect(createAnthropicRequest({ ...options, effort: "max" }).output_config?.effort).toBe("max");
});

const sdkOptions = {
    context: options.context,
    credential: { name: "claude-code" as const, credential: undefined },
    env: {},
    model: options.model,
    sessionId: "test-session",
    systemPrompt: "Test instructions.",
    tools: [],
};

it("rejects Ultra for Claude SDK instead of sending or downgrading it", () => {
    expect(() => toClaudeSdkOptions({ ...sdkOptions, effort: "ultra" })).toThrow(
        "Claude SDK does not support Ultra reasoning effort.",
    );
});

it("keeps Claude SDK max effort unchanged", () => {
    expect(toClaudeSdkOptions({ ...sdkOptions, effort: "max" }).effort).toBe("max");
});
