import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { agentModuleConfig, agentPermissionMode } from "@slopus/happy-agent-base";
import {
    AcpProvider,
    foreignAgent,
    type AcpPermissionAnswer,
    type AcpPermissionQuestion,
    type AcpTurnEnvironment,
    type ForeignAgent,
    type ForeignAgentStart,
    type ProviderUsage,
    type SessionSystemMessage,
} from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { HappyAgentConfigValues, HappyAgentConfiguration } from "../ConfigModule.js";
import {
    harnessAcceptsProvider,
    isAttachedHarness,
    isOwnLoginHarness,
    OWN_LOGIN_HARNESS_TYPES,
    type Harness,
} from "./harnesses.js";

type ConfiguredProvider = HappyAgentConfigValues["providers"][string];

/** The account entry an own-login harness is offered as. */
export type ForeignAgentConfiguredProvider = Extract<
    ConfiguredProvider,
    { readonly type: (typeof OWN_LOGIN_HARNESS_TYPES)[number] }
>;

export function isForeignAgentProvider(
    provider: ConfiguredProvider,
): provider is ForeignAgentConfiguredProvider {
    return (OWN_LOGIN_HARNESS_TYPES as readonly string[]).includes(provider.type);
}

/**
 * One foreign agent on one account: Claude Code or Codex CLI on a `claude` or `codex` provider
 * that harness accepts, or an agent with its own login on the account named after its harness.
 */
export interface ForeignAgentRoute {
    readonly harnessId: string;
    readonly harness: Harness;
    /** The account its models are listed under. */
    readonly providerId: string;
    readonly provider: ConfiguredProvider;
    readonly agent: ForeignAgent;
}

/** Every route an enabled harness serves, whether or not its account is enabled. */
export function foreignAgentRoutes(
    configuration: HappyAgentConfiguration,
): readonly ForeignAgentRoute[] {
    const { harnesses, providers } = configuration.values;
    const routes: ForeignAgentRoute[] = [];
    for (const [harnessId, harness] of Object.entries(harnesses)) {
        if (!harness.enabled) continue;
        if (isOwnLoginHarness(harness)) {
            const provider = providers[harnessId];
            if (provider === undefined) continue;
            routes.push({
                harnessId,
                harness,
                providerId: harnessId,
                provider,
                agent: foreignAgent(harness.type, harnessId),
            });
            continue;
        }
        if (!isAttachedHarness(harness)) continue;
        for (const [providerId, provider] of Object.entries(providers)) {
            if (!harnessAcceptsProvider(harness, providerId, provider)) continue;
            routes.push({
                harnessId,
                harness,
                providerId,
                provider,
                agent: foreignAgent(harness.type, harnessId),
            });
        }
    }
    return routes;
}

/** The foreign agent serving `modelId` on `providerId`, if any does. */
export function foreignAgentRouteForModel(
    configuration: HappyAgentConfiguration,
    providerId: string,
    modelId: string | undefined,
): ForeignAgentRoute | undefined {
    if (modelId === undefined) return undefined;
    return foreignAgentRoutes(configuration).find(
        (route) =>
            route.providerId === providerId && modelId.startsWith(`${route.agent.modelPrefix}/`),
    );
}

/** Whether Happy's own loop runs on `providerId`. */
export function happyHarnessAccepts(
    configuration: HappyAgentConfiguration,
    providerId: string,
    provider: ConfiguredProvider,
): boolean {
    if (isForeignAgentProvider(provider)) return false;
    const happy = configuration.values.harnesses["happy"];
    return happy === undefined || harnessAcceptsProvider(happy, providerId, provider);
}

/**
 * The foreign agent behind one route.
 *
 * The agent runs in the Happy agent's own folder — the one its compute is configured with — under
 * the permission mode the Happy agent is in when each turn starts. Whatever its own permission
 * system asks and that mode leaves open is put to the person through `askPermission`, and a turn
 * it starts on its own, such as after a background command finished, runs the agent again through
 * `wake` so that turn is shown. Its session
 * records live in a private directory per harness and account, so two accounts never continue
 * each other's foreign sessions.
 */
export function createForeignAgentProvider(
    route: ForeignAgentRoute,
    agentHome: string,
    onAccountUsage?: (usage: ProviderUsage) => void,
    askPermission?: ForeignAgentPermissionAsker,
    wake?: ForeignAgentWaker,
): AcpProvider {
    const directory = foreignAgentDirectory(agentHome, route);
    return new AcpProvider({
        connect: route.agent.connect({
            ...foreignAgentStart(route),
            // The agent names a reading after its vendor; it belongs to the account it ran on.
            onAccountUsage: (usage) => onAccountUsage?.({ ...usage, providerId: route.providerId }),
        }),
        stateDirectory: directory,
        environment: (ctx) => ({
            ...foreignAgentTurnEnvironment(ctx, directory),
            ...(askPermission === undefined
                ? {}
                : {
                      askPermission: (question: AcpPermissionQuestion, signal: AbortSignal) =>
                          askPermission(ctx, route.harnessId, question, signal),
                  }),
            ...(wake === undefined
                ? {}
                : { wake: (notice: SessionSystemMessage) => wake(ctx, notice) }),
        }),
        profile: route.agent.profile,
    });
}

/** Puts what a route's foreign agent asks to the person running it as `ctx`'s agent. */
export type ForeignAgentPermissionAsker = (
    ctx: Context,
    harnessId: string,
    question: AcpPermissionQuestion,
    signal: AbortSignal,
) => Promise<AcpPermissionAnswer>;

/** Runs `ctx`'s agent again with `notice`, for a turn its foreign agent started on its own. */
export type ForeignAgentWaker = (ctx: Context, notice: SessionSystemMessage) => void;

/** The private directory one route keeps its state in. */
export function foreignAgentDirectory(agentHome: string, route: ForeignAgentRoute): string {
    const harness = join(agentHome, "foreign-agents", encodeURIComponent(route.harnessId));
    return route.harnessId === route.providerId
        ? harness
        : join(harness, encodeURIComponent(route.providerId));
}

/**
 * How one route's agent is started: the account's credentials in the form its CLI reads them,
 * and the harness's command, arguments and extra variables.
 */
export function foreignAgentStart(route: ForeignAgentRoute): ForeignAgentStart {
    const { harness, provider, agent } = route;
    const credentials =
        provider.type === "claude"
            ? {
                  ...(provider.oauthToken === undefined ? {} : { oauthToken: provider.oauthToken }),
                  ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
                  ...(provider.authToken === undefined ? {} : { authToken: provider.authToken }),
                  ...(provider.configDir === undefined ? {} : { configDir: provider.configDir }),
              }
            : provider.type === "codex"
              ? {
                    ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
                    ...(provider.authFile === undefined
                        ? {}
                        : { configDir: codexHome(provider.authFile) }),
                }
              : provider.type === "antigravity" || provider.type === "opencode"
                ? provider.apiKey === undefined
                    ? {}
                    : { apiKey: provider.apiKey }
                : {};
    return {
        ...(harness.command === undefined ? {} : { command: harness.command }),
        ...(harness.args === undefined ? {} : { args: harness.args }),
        env: { ...agent.credentialEnvironment(credentials), ...harness.env },
    };
}

/** Codex reads its login from `$CODEX_HOME/auth.json`. */
function codexHome(authFile: string): string {
    if (basename(authFile) !== "auth.json") {
        throw new Error(
            `Codex CLI reads its login from a folder's auth.json; "${authFile}" is not one.`,
        );
    }
    return dirname(authFile);
}

/**
 * A request without an agent's compute, such as naming a chat, still starts a whole foreign
 * agent. It gets an empty private folder and read-only access instead of the daemon's own folder.
 */
function foreignAgentTurnEnvironment(ctx: Context, stateDirectory: string): AcpTurnEnvironment {
    const compute = agentModuleConfig(ctx, "compute");
    if (typeof compute?.["cwd"] === "string" && compute["cwd"].length > 0) {
        return { cwd: compute["cwd"], permissionMode: agentPermissionMode(ctx) };
    }
    const cwd = join(stateDirectory, "detached");
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    return { cwd, permissionMode: "read_only" };
}
