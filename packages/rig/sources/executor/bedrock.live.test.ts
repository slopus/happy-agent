import { describe, expect, it } from "vitest";

import { modelAnthropicSonnet5, modelOpenaiGpt56Sol } from "@slopus/rig-execution";
import { Executor } from "@slopus/rig-execution";
import { bedrockExecution } from "./bedrockExecution.js";
import { createTestRootContext } from "../testing/createTestRootContext.js";
import { readBedrockBearerToken } from "../model-catalog/bedrock/readBedrockBearerToken.js";
import { resolveBedrockRegion } from "../model-catalog/bedrock/resolveBedrockRegion.js";
import type { AssistantMessage, Model, TextContent } from "@slopus/rig-execution";

const LIVE = process.env.RIG_LIVE_TEST === "1";
const HAS_BEDROCK_TOKEN = readBedrockBearerToken(process.env) !== undefined;
const describeLive = LIVE && HAS_BEDROCK_TOKEN ? describe : describe.skip;
const LIVE_REGION = resolveBedrockRegion(process.env);
const GPT_56_SOL_REGIONS = ["us-east-1", "us-east-2"];
const LIVE_OPENAI_MODEL = GPT_56_SOL_REGIONS.includes(LIVE_REGION)
    ? modelOpenaiGpt56Sol
    : undefined;

function textFromAssistantMessage(message: AssistantMessage): string {
    return message.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("");
}

async function expectOkFromModel(model: Model, thinking = "off"): Promise<void> {
    const provider = new Executor([bedrockExecution({ env: process.env })]);
    const stream = provider.stream(
        createTestRootContext().named("bedrock-live-test"),
        model,
        {
            messages: [
                {
                    role: "user",
                    content: "Reply with exactly: ok",
                    timestamp: Date.now(),
                },
            ],
        },
        { thinking },
    );

    let sawStart = false;
    let sawText = false;
    for await (const event of stream) {
        if (event.type === "start") {
            sawStart = true;
        }
        if (event.type === "text_delta" && event.delta.length > 0) {
            sawText = true;
        }
        if (event.type === "error") {
            throw new Error(event.error.errorMessage ?? "Amazon Bedrock stream failed");
        }
    }

    const message = await stream.result();
    expect(sawStart).toBe(true);
    expect(sawText).toBe(true);
    expect(message.stopReason).not.toBe("error");
    expect(textFromAssistantMessage(message).trim().toLowerCase()).toBe("ok");
}

describeLive("Amazon Bedrock provider live", () => {
    it("streams an Anthropic model through its preferred Bedrock endpoint", async () => {
        await expectOkFromModel(modelAnthropicSonnet5);
    }, 120_000);

    it.skipIf(LIVE_OPENAI_MODEL === undefined)(
        "streams an OpenAI model through Bedrock Mantle using the developer environment",
        async () => {
            await expectOkFromModel(LIVE_OPENAI_MODEL!);
        },
        120_000,
    );
});

describe("Amazon Bedrock provider live prerequisites", () => {
    it("documents how to run the live test", () => {
        if (LIVE && !HAS_BEDROCK_TOKEN) {
            expect.fail("RIG_LIVE_TEST=1 is set but AWS_BEARER_TOKEN_BEDROCK is missing or blank");
        }

        expect(true).toBe(true);
    });
});
