import { dirname, join, resolve } from "node:path";

import type { AgentModule } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { ConfigModule } from "../config/index.js";
import type { ProviderClisModule } from "../providerClis/index.js";
import type { ProviderScanModule } from "../providerScan/index.js";
import { ProviderRouteRequestError, type ProviderRoute } from "./ProviderRoute.js";
import { accountHomeRoutes } from "./impl/accountHomeRoutes.js";
import { assembleProviderRoutes } from "./impl/assembleProviderRoutes.js";
import { cliProxyApiRoutes } from "./impl/cliProxyApiRoutes.js";
import { awsProfileRoutes } from "./impl/awsProfileRoutes.js";
import { localModelRoutes } from "./impl/localModelRoutes.js";
import { claudeCodeRouterRoutes } from "./impl/claudeCodeRouterRoutes.js";
import type { ConfiguredProviders, DetectedRoute } from "./impl/DetectedRoute.js";
import { detectDirectRoutes } from "./impl/detectDirectRoutes.js";
import { envKeyRoutes } from "./impl/envKeyRoutes.js";
import { homeOf, type RouteMachine } from "./impl/RouteMachine.js";

/**
 * Finds every way this computer can already reach models, without inference, and sets a chosen
 * route up with its recommended configuration. See "Provider routes" in API.md.
 */
export class ProviderRoutesModule implements AgentModule {
    readonly name = "provider-routes";
    readonly #config: ConfigModule;
    readonly #providerClis: ProviderClisModule;
    readonly #providerScan: ProviderScanModule;

    constructor(
        config: ConfigModule,
        providerClis: ProviderClisModule,
        providerScan: ProviderScanModule,
    ) {
        this.#config = config;
        this.#providerClis = providerClis;
        this.#providerScan = providerScan;
    }

    /** Detect every route again. */
    async list(ctx: Context): Promise<ProviderRoute[]> {
        return assembleProviderRoutes(await this.#detect(ctx), this.#providers());
    }

    /**
     * Set one route up as its `use` says: turn a configured provider on, or add the new provider
     * to runtime.toml for the next start.
     */
    async use(
        ctx: Context,
        routeId: string,
    ): Promise<{ readonly route: ProviderRoute; readonly restartRequired: boolean }> {
        const detected = await this.#detect(ctx);
        const routes = assembleProviderRoutes(detected, this.#providers());
        const route = routes.find((candidate) => candidate.id === routeId);
        const found = detected.find((candidate) => candidate.id === routeId);
        if (route === undefined || found === undefined) {
            throw new ProviderRouteRequestError("not_found", "Route not found.", null);
        }
        if (route.use === null) {
            throw new ProviderRouteRequestError(
                "conflict",
                route.providerId === null
                    ? `${route.name} can't be set up automatically right now.`
                    : `${route.name} is already set up.`,
                route,
            );
        }
        if (route.use.restartRequired && found.provider !== undefined) {
            await this.#config.addRuntimeProvider(ctx, found.provider.id, found.provider.table);
        } else {
            await this.#providerScan.setOverrides(ctx, {
                [route.use.providerId]: { enabled: true },
            });
        }
        const after = assembleProviderRoutes(detected, this.#providers()).find(
            (candidate) => candidate.id === routeId,
        );
        return { route: after ?? route, restartRequired: route.use.restartRequired };
    }

    async #detect(ctx: Context): Promise<DetectedRoute[]> {
        const machine = this.#machine();
        const [direct, ...found] = await Promise.all([
            this.#detector(ctx, "provider CLIs", async () =>
                detectDirectRoutes(await this.#providerClis.list(ctx), (providerId, vendor) =>
                    this.#models(providerId, vendor),
                ),
            ),
            this.#detector(
                ctx,
                "other account folders",
                async () =>
                    await accountHomeRoutes(
                        machine,
                        (type) => this.#models(type, type === "claude" ? "Anthropic" : "OpenAI"),
                        (type, folder) => this.#providerUsingFolder(type, folder),
                    ),
            ),
            this.#detector(ctx, "CLIProxyAPI", async () => await cliProxyApiRoutes(machine)),
            this.#detector(
                ctx,
                "AWS profiles",
                async () =>
                    await awsProfileRoutes(machine, await this.#bedrock(), (profile) =>
                        this.#bedrockProviderFor(profile),
                    ),
            ),
            this.#detector(
                ctx,
                "local model servers",
                async () => await localModelRoutes(machine, this.#config.localModelServerPorts),
            ),
            this.#detector(
                ctx,
                "Claude Code Router",
                async () => await claudeCodeRouterRoutes(machine),
            ),
        ]);
        const keys = await this.#detector(ctx, "the environment", async () =>
            envKeyRoutes(
                machine,
                (providerId) => this.#usesAmbientCredentials(providerId),
                (providerId) =>
                    direct.some((route) => route.id === providerId && route.status === "ready"),
            ),
        );
        // A route is a configured provider only when this daemon actually runs that provider.
        return [direct, keys, ...found].flat().map((route) => {
            if (route.providerId === undefined || this.#isProvider(route.providerId)) return route;
            const { providerId: _providerId, ...rest } = route;
            return rest;
        });
    }

    /** One detector's routes; a detector that fails hides only its own routes. */
    async #detector(
        ctx: Context,
        name: string,
        detect: () => Promise<DetectedRoute[]>,
    ): Promise<DetectedRoute[]> {
        try {
            return await detect();
        } catch (error: unknown) {
            ctx.log.warn(`Detecting provider routes from ${name} failed.`, {}, error);
            return [];
        }
    }

    #machine(): RouteMachine {
        return {
            platform: process.platform,
            env: this.#config.processEnvironment,
            programDirectories: this.#config.programDirectories,
        };
    }

    /** A built-in provider reads keys from the environment unless its configuration names one. */
    #usesAmbientCredentials(providerId: string): boolean {
        if (!this.#isProvider(providerId)) return false;
        const provider = this.#config.configuration.values.providers[providerId] as
            | Readonly<Record<string, unknown>>
            | undefined;
        return ["apiKey", "authFile", "authToken", "configDir", "oauthToken"].every(
            (field) => provider?.[field] === undefined,
        );
    }

    /** The built-in Bedrock provider, when this daemon runs it, and whether AWS credentials are local. */
    async #bedrock(): Promise<{ providerId: string; available: boolean } | null> {
        if (!this.#isProvider("bedrock")) return null;
        try {
            const found = await this.#config.probeLocalProviderCredentials("bedrock");
            return { providerId: "bedrock", available: found === "available" };
        } catch {
            return { providerId: "bedrock", available: false };
        }
    }

    /** A configured Bedrock provider already using this AWS profile. */
    #bedrockProviderFor(profile: string): string | undefined {
        for (const [id, provider] of Object.entries(this.#config.configuration.values.providers)) {
            if (provider.type === "bedrock" && provider.profile === profile) return id;
        }
        return undefined;
    }

    /** A configured Claude provider with this config folder, or Codex provider with its auth file. */
    #providerUsingFolder(type: "claude" | "codex", folder: string): string | undefined {
        const home = homeOf(this.#machine());
        const expand = (path: string) =>
            resolve(path.startsWith("~/") ? join(home, path.slice(2)) : path);
        for (const [id, provider] of Object.entries(this.#config.configuration.values.providers)) {
            const path =
                type === "claude" && provider.type === "claude"
                    ? provider.configDir
                    : type === "codex" && provider.type === "codex" && provider.authFile
                      ? dirname(expand(provider.authFile))
                      : undefined;
            if (path !== undefined && expand(path) === folder) return id;
        }
        return undefined;
    }

    #isProvider(providerId: string): boolean {
        return this.#config.providerIds.includes(providerId);
    }

    #models(providerId: string, vendor: string | null): ProviderRoute["models"] {
        if (!this.#isProvider(providerId)) return null;
        return this.#config.offeredModels
            .filter((model) => model.providerId === providerId)
            .slice(0, 500)
            .map((model) => ({ id: model.id, vendor }));
    }

    #providers(): ConfiguredProviders {
        const config = this.#config;
        return {
            has: (providerId) => config.hasProvider(providerId),
            isEnabled: (providerId) => config.isProviderEnabled(providerId),
            typeOf: (providerId) => config.providerType(providerId),
            at: (baseUrl) => config.openAICompatibleProviderAt(baseUrl),
        };
    }
}
