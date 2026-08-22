import type { AgentProviders } from "@slopus/happy-agent-base";
import {
    CodexImageGenerationError,
    CodexProvider,
    type GenerateCodexImageResult,
} from "@slopus/happy-providers";

/** Every configured Codex account, in the order this generation should try them. */
export function codexImageProviderIds(
    providers: AgentProviders,
    isEnabled: (providerId: string) => boolean = () => true,
): readonly string[] {
    return providers.ids.filter((id) => providers.typeOf(id) === "codex" && isEnabled(id));
}

export interface CodexImageGenerationRequest {
    readonly providers: AgentProviders;
    /** The accounts to try, best first. */
    readonly order: readonly string[];
    readonly prompt: string;
    readonly images: readonly string[];
    readonly turnId: string;
    readonly signal?: AbortSignal;
}

/**
 * One image, from the first account willing to make it.
 *
 * A person can have several Codex accounts, and an account can refuse for reasons that have
 * nothing to do with the request — signed out, out of credit, not entitled to the model. Those
 * refusals are definitive and cost nothing, so the next account is tried. Anything else stops
 * immediately: a transport failure or a malformed answer may already have been billed, and
 * quietly paying for the same image twice is worse than reporting the failure.
 */
export async function generateImageWithCodex(
    request: CodexImageGenerationRequest,
): Promise<GenerateCodexImageResult> {
    if (request.order.length === 0) {
        throw new Error(
            "No Codex account is configured, so image generation is unavailable. Sign in with Codex to generate images.",
        );
    }
    const failures: string[] = [];
    for (const providerId of request.order) {
        const provider = await request.providers.resolve(providerId, undefined);
        if (!(provider instanceof CodexProvider)) {
            failures.push(`Provider "${providerId}" cannot generate images.`);
            continue;
        }
        try {
            return await provider.generateImage({
                ...(request.images.length === 0 ? {} : { images: request.images }),
                prompt: request.prompt,
                ...(request.signal === undefined ? {} : { signal: request.signal }),
                turnId: request.turnId,
            });
        } catch (error: unknown) {
            request.signal?.throwIfAborted();
            if (!(error instanceof CodexImageGenerationError) || !error.fallbackEligible) {
                throw error;
            }
            failures.push(error.message);
        }
    }
    throw new Error(`No configured Codex image provider succeeded. ${failures.join(" ")}`);
}
