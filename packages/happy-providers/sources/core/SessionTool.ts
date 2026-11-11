import type { TSchema } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

/** Lark grammar for OpenAI-style custom tool call syntax. */
export interface SessionToolLarkGrammar {
    readonly type: "lark";
    readonly grammar: string;
}

/** Tool definition supplied to a session. Mapping to provider wire format is vendor-specific. */
export interface SessionTool {
    readonly name: string;
    readonly namespace?: string;
    /** Description of the containing namespace, when this tool is namespaced. */
    readonly namespaceDescription?: string;
    /**
     * Exact native tool descriptor for a call the provider owns and settles inside its response.
     *
     * Absence means the caller owns execution. Provider mappers pass this descriptor through
     * instead of deriving a native tool type from `name`.
     */
    readonly server?: { readonly type: string; readonly [key: string]: unknown };
    readonly description?: string;
    readonly parameters?: TSchema;
    /** Additional provider-owned discovery terms that describe this tool. */
    readonly searchKeywords?: readonly string[];
    /** Provider-neutral request to expose this tool through native tool discovery. */
    readonly defer?: boolean;
    /** Ignored by providers that do not support grammar-based tools. */
    readonly grammar?: SessionToolLarkGrammar;
    /**
     * `"never"`: no call of this tool ever needs approval, so an agent that gates tool calls with
     * its own permission system may run it without asking.
     */
    readonly autoReview?: "never";
    /**
     * Whether this exact call needs approval. An agent that asks before calling one of the
     * caller's tools is answered from this; absent, every call needs approval.
     */
    readonly shouldReviewInAutoMode?: (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool types its own arguments
        args: any,
        ctx: Context,
    ) => boolean | Promise<boolean>;
}

export interface SessionToolsOptions {
    readonly tools?: readonly SessionTool[];
}
