import {
    ANTHROPIC_THINKING_BINDING_BETA,
    type AnthropicRequest,
} from "@/protocol/anthropic/createAnthropicRequest.js";
import type { AnthropicBedrockTransport } from "@/vendors/bedrock/AnthropicBedrockTransport.js";
import { resolveAnthropicBedrockErrorStatus } from "@/vendors/bedrock/impl/anthropicBedrockRetry.js";
import { isAnthropicThinkingPrefixMismatch } from "@/vendors/bedrock/impl/anthropicBedrockThinkingHeal.js";

/**
 * The models whose replayed thinking blocks get a prefix check on Bedrock: the system prompt, the
 * tools, and every earlier message must be what they were when the block was produced, or the
 * request is rejected with "The block is bound to a different conversation". AWS lists them in
 * the Bedrock user guide's "Preserved thinking" page. Earlier models never run the check and are
 * reported to refuse the control, so they are not sent it.
 */
const PREFIX_CHECKED_MODELS = [
    "fable-5-2",
    "mythos-5-2",
    "fable-5-1",
    "opus-5-5",
    "sonnet-5-5",
    "haiku-5-5",
] as const;

/**
 * Whether a request should ask Bedrock to drop mismatched thinking instead of failing.
 *
 * A caller's system prompt and tools legitimately change during a conversation, and one changed
 * byte would otherwise end it for good, because the stored history still holds the old thinking.
 * Claude Code sends the same control for the same reason. Only Runtime is covered: AWS documents
 * the control for `InvokeModel`, and Fable 5.2 is served nowhere else on Bedrock. A model named
 * only by an opaque ARN cannot be recognized and keeps the API's default.
 */
export function dropsMismatchedAnthropicBedrockThinking(options: {
    model: string;
    transport: AnthropicBedrockTransport;
    wireModel: string;
}): boolean {
    if (options.transport !== "runtime") return false;
    return PREFIX_CHECKED_MODELS.some(
        (name) =>
            options.model === `anthropic/${name}` || options.wireModel.includes(`claude-${name}`),
    );
}

export function carriesAnthropicThinkingBinding(request: AnthropicRequest): boolean {
    return request.betas?.includes(ANTHROPIC_THINKING_BINDING_BETA) === true;
}

/**
 * Recognizes an endpoint that does not take the control at all: a gateway, region, or account
 * that rejects the field or its beta. Sending it again would fail every request, so the session
 * stops sending it. The three messages are the ones Claude Code gives up on.
 *
 * A prefix mismatch is not a refusal. It also names the beta when a proxy removed it on the way,
 * and resending without the control could only repeat it.
 */
export function isAnthropicThinkingBindingRefusal(error: unknown): boolean {
    if (resolveAnthropicBedrockErrorStatus(error) !== 400) return false;
    const message = error instanceof Error ? error.message : String(error);
    if (isAnthropicThinkingPrefixMismatch(error)) return false;
    return (
        /thinking\.(adaptive|enabled)\.block_binding(\.prefix_mismatch_behavior)?: Extra inputs are not permitted/.test(
            message,
        ) ||
        message.includes(ANTHROPIC_THINKING_BINDING_BETA) ||
        message.toLowerCase().includes("invalid beta flag")
    );
}
