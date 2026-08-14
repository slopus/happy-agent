import type { SessionModelConfiguration } from "@/core/SessionModelConfiguration.js";
import type { SessionToolsOptions } from "@/core/SessionTool.js";

/**
 * Immutable model-visible configuration for a session.
 *
 * A session is created from instructions and tools only. Conversation history belongs to the
 * caller, which supplies the complete transcript with every run and compaction; sessions never
 * receive initial messages at creation.
 */
export interface SessionOptions extends SessionToolsOptions {
    /**
     * Retry budget for this session alone, overriding the provider's own. Zero means a failure is
     * reported the moment it happens. Omit it to retry the way the provider normally would.
     */
    readonly inferenceMaxRetries?: number;
    /**
     * Fatal-failure retry budget for this session alone, overriding the provider's own. Omit it
     * to follow the provider, whose own default is zero.
     */
    readonly inferenceFatalRetries?: number;
    readonly instructions: string;
    /**
     * Alternate model-visible configurations supplied when a session can switch between
     * models whose instructions or tools differ.
     */
    readonly modelConfigurations?: Readonly<Record<string, SessionModelConfiguration>>;
}
