import type { ProviderCli } from "../../providerClis/index.js";
import type { ProviderRoute } from "../ProviderRoute.js";
import type { DetectedRoute } from "./DetectedRoute.js";

/** The built-in providers backed by a provider CLI's default sign-in, and whose models they are. */
const VENDORS: Readonly<Record<string, string>> = {
    claude: "Anthropic",
    codex: "OpenAI",
    grok: "xAI",
};

/**
 * One route per vendor sign-in the provider CLIs found: installed, or signed in without the
 * program. Antigravity runs as a harness rather than a provider, so it is not a route.
 */
export function detectDirectRoutes(
    providerClis: readonly ProviderCli[],
    models: (providerId: string, vendor: string) => ProviderRoute["models"],
): DetectedRoute[] {
    return providerClis.flatMap((cli): DetectedRoute[] => {
        const vendor = VENDORS[cli.id];
        if (vendor === undefined) return [];
        const installed = cli.installation.status === "installed";
        if (!installed && cli.signIn.status !== "signed_in") return [];
        const account = cli.signIn.account;
        return [
            {
                id: cli.id,
                kind: cli.installation.source === "desktop_app" ? "desktop_app" : "direct",
                name:
                    cli.installation.desktopApp === null
                        ? cli.name
                        : `${cli.name} in the ${cli.installation.desktopApp} app`,
                vendors: [vendor],
                billing: "subscription",
                account:
                    account === null
                        ? null
                        : {
                              label: account.email,
                              email: account.email,
                              plan: account.plan,
                              count: null,
                          },
                endpoint: null,
                status:
                    cli.signIn.status === "signed_in"
                        ? "ready"
                        : cli.signIn.status === "signed_out"
                          ? "needs_sign_in"
                          : "unknown",
                models: models(cli.id, vendor),
                warning: null,
                providerId: cli.id,
            },
        ];
    });
}
