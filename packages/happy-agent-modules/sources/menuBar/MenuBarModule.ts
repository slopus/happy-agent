import type { AgentModule } from "@slopus/happy-agent-base";
import { detach, type Context } from "@steve.kite/stdlib";

import { ConfigModule } from "../config/index.js";
import { MenuBarApp } from "./impl/MenuBarApp.js";
import { resolveMenuBarApp } from "./impl/resolveMenuBarApp.js";

/**
 * The Happy Agent menu bar.
 *
 * A small native app shows what the agents are doing without anyone having to open a window: how
 * many are working, in which projects, and how much of each provider's session and week is spent.
 * This module owns that app completely — it decides whether this daemon has a menu bar at all,
 * starts the app, restarts it if it falls over, and stops it when the daemon shuts down.
 *
 * Only a released Happy Agent binary carries the app, so a daemon run from a checkout — during
 * development, or from a test — has no menu bar to start and says nothing about it.
 *
 * The app is a reader. It talks to the daemon's ordinary HTTP API over the same private socket
 * every other client uses, so it can show nothing the person could not already see and can change
 * nothing at all.
 */
export class MenuBarModule implements AgentModule {
    readonly name = "menuBar";

    readonly #config: ConfigModule;
    #app: MenuBarApp | undefined;
    #supervising: Promise<unknown> | undefined;

    constructor(config: ConfigModule) {
        this.#config = config;
    }

    readonly beforeStart = (ctx: Context): void => {
        if (this.#config.configuration.values.feature.team.enabled) return;
        if (!this.#config.configuration.values.settings.menuBar) return;
        const executable = resolveMenuBarApp();
        if (executable === undefined) return;
        const paths = this.#config.configuration.paths;
        this.#app = new MenuBarApp(executable, [
            "--socket",
            paths.socketPath,
            "--token-file",
            paths.tokenPath,
        ]);
        // The app outlives the call that starts it, so it gets a lifetime of its own rather than
        // borrowing the startup pass's.
        this.#supervising = this.#app.supervise(detach(ctx).named("menu-bar"));
    };

    /** Stops the app and waits for it to leave. Starting again afterwards is not supported. */
    async close(): Promise<void> {
        this.#app?.stop();
        await this.#supervising;
        this.#supervising = undefined;
        this.#app = undefined;
    }
}
