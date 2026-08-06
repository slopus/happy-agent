import { type HostedCapability } from "@slopus/rig-execution";

import type { PermissionMode } from "../permissions/index.js";
import { permissionModeAllowsWebSearch } from "./networkToolPermission.js";

/**
 * The searches a provider's own backend runs.
 *
 * Which of them Rig declares is not a user's decision and is not configurable. It is the same kind
 * of choice as which tools a request carries: a harness detail. What the backend can do is a fact
 * about the backend, so it is stated here and nowhere else.
 */
export function hostedSearchesFor(providerType: string | undefined): readonly HostedCapability[] {
    if (providerType === "grok") return GROK_SEARCHES;
    if (providerType === "codex") return WEB_SEARCH_ONLY;
    return [];
}

/** Grok's backend searches the web and X. OpenAI's searches the web; X search is Grok's alone. */
const GROK_SEARCHES: readonly HostedCapability[] = ["web_search", "x_search"];
const WEB_SEARCH_ONLY: readonly HostedCapability[] = ["web_search"];

/**
 * Whether a provider-run search may be declared on the request being built.
 *
 * One rule, and it is the same one a search Rig executes answers to. A hosted search is enforced
 * here rather than when it is called because there is no call to intercept: the provider runs it
 * inside its own response, so declining to declare it is the whole enforcement.
 */
export function permissionModeAllowsProviderRunSearch(mode: PermissionMode | undefined): boolean {
    return permissionModeAllowsWebSearch(mode);
}
