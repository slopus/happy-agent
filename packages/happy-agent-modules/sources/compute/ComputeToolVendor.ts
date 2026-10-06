import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { providerModelFamily } from "@slopus/happy-providers";

/** The vendors whose own filesystem and shell surface this module can serve. */
export const computeToolVendorSchema = Type.Union([
    Type.Literal("claude"),
    Type.Literal("codex"),
    Type.Literal("grok"),
    Type.Literal("kimi"),
    Type.Literal("glm"),
]);

/** The TypeScript type inferred from {@link computeToolVendorSchema}. */
export type ComputeToolVendor = Static<typeof computeToolVendorSchema>;

/** The kinds of provider Agent Base can report for an agent. */
const computeToolProviderKindSchema = Type.Union([
    Type.Literal("bedrock"),
    Type.Literal("claude"),
    Type.Literal("codex"),
    Type.Literal("grok"),
    Type.Literal("gym"),
]);

/** The largest model identifier vendor selection accepts. */
export const MAX_COMPUTE_TOOL_MODEL_LENGTH = 256;

/** What Agent Base knows about an agent's model when its tools are assembled. */
export const computeToolSelectionSchema = Type.Object(
    {
        model: Type.Union([
            Type.String({
                minLength: 1,
                maxLength: MAX_COMPUTE_TOOL_MODEL_LENGTH,
                pattern: "^[^\\u0000\\r\\n]+$",
            }),
            Type.Undefined(),
        ]),
        providerKind: Type.Optional(computeToolProviderKindSchema),
    },
    { additionalProperties: false },
);

/** The TypeScript type inferred from {@link computeToolSelectionSchema}. */
export type ComputeToolSelection = Static<typeof computeToolSelectionSchema>;

/** The surface an agent gets when nothing yet says which model it will run on. */
const DEFAULT_COMPUTE_TOOL_VENDOR: ComputeToolVendor = "codex";

/**
 * Whose own tools this agent should be handed.
 *
 * The model ID names the vendor even when the provider does not — a Claude model served through
 * Bedrock is still a Claude model, and giving it Codex's tools would hand it names it was never
 * trained on — so the ID decides first and the kind of provider only answers when the ID says
 * nothing. An agent that has not chosen a model yet still gets a working machine rather than an
 * empty one, because a freshly created agent that cannot read a file is simply broken.
 */
export function computeToolVendor(selection: ComputeToolSelection): ComputeToolVendor {
    if (!Value.Check(computeToolSelectionSchema, selection)) {
        throw new Error("Compute tool model selection is invalid.");
    }
    const family = selection.model === undefined ? undefined : providerModelFamily(selection.model);
    if (family !== undefined) return family;
    const kind = selection.providerKind;
    if (kind === "claude" || kind === "codex" || kind === "grok") return kind;
    return DEFAULT_COMPUTE_TOOL_VENDOR;
}
