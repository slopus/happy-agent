import type { AnthropicRequest } from "@/protocol/anthropic/createAnthropicRequest.js";
import {
    collectAnthropicCompaction,
    type CollectedAnthropicCompaction,
} from "@/protocol/anthropic/collectAnthropicCompaction.js";
import type { AnthropicBedrockClient } from "@/vendors/bedrock/impl/createAnthropicBedrockClient.js";
import {
    isTransientAnthropicBedrockError,
    resolveAnthropicBedrockRetryDelay,
    waitForAnthropicBedrockRetry,
} from "@/vendors/bedrock/impl/anthropicBedrockRetry.js";

export async function requestAnthropicBedrockCompaction(options: {
    client: AnthropicBedrockClient;
    request: AnthropicRequest;
    signal?: AbortSignal;
    maxRetries: number;
}): Promise<CollectedAnthropicCompaction> {
    let failedAttempts = 0;
    for (;;) {
        let responseContentStarted = false;
        try {
            const response = await options.client.beta.messages.create(
                options.request,
                options.signal === undefined ? undefined : { signal: options.signal },
            );
            return await collectAnthropicCompaction(response, {
                onOutputStarted: () => {
                    responseContentStarted = true;
                },
                ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
        } catch (error) {
            if (responseContentStarted) throw error;
            failedAttempts += 1;
            // Compaction retries stay transient-only: a fatal rejection of a compaction request
            // is reported to the caller, which owns the decision to compact differently.
            if (!isTransientAnthropicBedrockError(error) || failedAttempts > options.maxRetries)
                throw error;
            const delay = resolveAnthropicBedrockRetryDelay(error, failedAttempts);
            await waitForAnthropicBedrockRetry(delay, options.signal);
        }
    }
}
