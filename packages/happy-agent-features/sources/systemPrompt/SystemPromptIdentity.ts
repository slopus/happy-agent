import { Type, type Static } from "@sinclair/typebox";

/** The largest safe name an agent may use in a model-facing identity. */
export const MAX_SYSTEM_PROMPT_IDENTITY_NAME_LENGTH = 128;
/** The largest safe identity sentence accepted from a host. */
export const MAX_SYSTEM_PROMPT_IDENTITY_PROMPT_LENGTH = 4_096;

const identityNamePattern = "^(?=.*\\S)[^\\u0000\\r\\n{}]*$";
const identityPromptPattern = "^(?=.*\\S)(?![\\s\\S]*\\{\\{(?:identity|name)\\}\\})[^\\u0000]*$";

/**
 * The identity substituted into a provider prompt.
 *
 * The schema deliberately excludes prompt markers and control NULs. This keeps a caller's
 * identity from leaving an unresolved template or changing the feature's composition rules.
 */
export const systemPromptIdentitySchema = Type.Object(
    {
        /** The name the agent answers to, replacing every `{{name}}` marker. */
        name: Type.String({
            minLength: 1,
            maxLength: MAX_SYSTEM_PROMPT_IDENTITY_NAME_LENGTH,
            pattern: identityNamePattern,
        }),
        /** The sentence that opens the prompt, replacing the `{{identity}}` marker. */
        prompt: Type.String({
            minLength: 1,
            maxLength: MAX_SYSTEM_PROMPT_IDENTITY_PROMPT_LENGTH,
            pattern: identityPromptPattern,
        }),
    },
    { additionalProperties: false },
);

/** The TypeScript type inferred from {@link systemPromptIdentitySchema}. */
export type SystemPromptIdentity = Static<typeof systemPromptIdentitySchema>;

/** The identity a prompt carries when the host never names another. */
export const DEFAULT_SYSTEM_PROMPT_IDENTITY: SystemPromptIdentity = Object.freeze({
    name: "Rig",
    prompt: "You are Rig, built by Happy",
});
