import type { ProviderRoute } from "../ProviderRoute.js";

/** What one detector found, before overlaps, the recommendation, and `use` are worked out. */
export type DetectedRoute = Omit<
    ProviderRoute,
    "overlaps" | "recommended" | "providerId" | "use"
> & {
    /** The configured provider this route already is, such as the built-in `claude`. */
    readonly providerId?: string;
    /**
     * The routes this one quietly takes the place of, such as the Claude Code sign-in a
     * `CLAUDE_CODE_OAUTH_TOKEN` replaces: the same provider uses this route instead, so each of
     * them starts unchecked and says why with `warning`.
     */
    readonly replaces?: readonly { readonly routeId: string; readonly warning: string }[];
    /**
     * The provider choosing this route adds. Its table may hold a key copied from another
     * program's configuration, so it is written to runtime.toml and never projected.
     */
    readonly provider?: {
        readonly id: string;
        readonly table: Readonly<Record<string, unknown>> & { readonly type: string };
        readonly summary: string;
    };
};

/** What the routes need to know about configured providers. */
export interface ConfiguredProviders {
    /** Configured, or added to runtime.toml and waiting for a restart. */
    has(providerId: string): boolean;
    isEnabled(providerId: string): boolean;
    typeOf(providerId: string): string | null;
    /** The configured OpenAI-compatible provider already pointing at this base URL. */
    at(baseUrl: string): string | undefined;
}
