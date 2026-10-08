/** How Happy names the service behind a model. */
export interface HappyProviderDescriptor {
    id: string;
    /**
     * The provider type, exactly as `/v0/config` reports it, or `"unknown"`. Always a string: the
     * phone rejects the whole metadata document over a missing or null kind.
     */
    kind: string;
    name: string;
}

const KNOWN_PROVIDER_NAMES: Readonly<Record<string, string>> = {
    claude: "Anthropic Claude",
    codex: "OpenAI Codex",
    grok: "xAI Grok",
};

/**
 * Describes a provider for the phone, in words rather than an identifier.
 *
 * `kind` is the account's provider type, so a second Claude account such as `claude_extra` is
 * still `claude`. It is never guessed from the account id; an account with no known type, such as
 * one no longer configured, is `unknown`.
 */
export function describeHappyProvider(
    providerId: string,
    providerType: string | null,
): HappyProviderDescriptor {
    return {
        id: providerId,
        kind: providerType ?? "unknown",
        name:
            (providerType === null ? undefined : KNOWN_PROVIDER_NAMES[providerType]) ??
            providerId
                .replaceAll(/[_-]+/gu, " ")
                .replaceAll(/\b\w/gu, (character) => character.toUpperCase()),
    };
}

/** Each provider behind these models once, in the order its first model appears. */
export function describeHappyProviders(
    models: readonly { readonly providerId: string; readonly providerType: string | null }[],
): HappyProviderDescriptor[] {
    const providers = new Map<string, HappyProviderDescriptor>();
    for (const model of models) {
        if (providers.has(model.providerId)) continue;
        providers.set(
            model.providerId,
            describeHappyProvider(model.providerId, model.providerType),
        );
    }
    return [...providers.values()];
}
