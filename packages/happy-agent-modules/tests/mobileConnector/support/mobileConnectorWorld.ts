import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureAgentDatabaseConnection, type AgentModuleHooks } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { vi } from "vitest";

import type { BotsModule } from "../../../sources/bots/index.js";
import { ConfigModule } from "../../../sources/config/index.js";
import { DurableFunctionsModule } from "../../../sources/durableFunctions/DurableFunctionsModule.js";
import { MobileConnectorModule } from "../../../sources/mobileConnector/index.js";
import type { MobileConnectorEvent } from "../../../sources/mobileConnector/index.js";
import { mobileConnectorMigrations } from "../../../sources/mobileConnector/MobileConnectorMigrations.js";
import type { NodeModule } from "../../../sources/node/index.js";
import { TailcatModule } from "../../../sources/tailcat/index.js";
import { TeamModule } from "../../../sources/team/index.js";
import { durableFunctionsHarness } from "../../durableFunctions/support/durableFunctionsHarness.js";
import { moduleDatabase, type ModuleDatabase } from "../../support/moduleDatabase.js";
import { testProfileModule } from "../../support/testProfileModule.js";

export const FAKE_TAILCAT_ADDRESS = "tcMobileConnectorTestAddress";

export interface MobileConnectorWorld {
    readonly ctx: Context;
    readonly database: ModuleDatabase;
    readonly events: MobileConnectorEvent[];
    readonly mobile: MobileConnectorModule;
    readonly port: number;
    readonly root: string;
    readonly tailcat: TailcatModule;
    /** Stop this daemon's modules but keep its database, as a process exit would. */
    readonly stop: () => Promise<void>;
    readonly close: () => Promise<void>;
}

export interface MobileConnectorWorldOptions {
    /** The configured socket port; one that is free right now when omitted. */
    readonly port?: number;
    readonly enabled?: boolean;
    readonly team?: boolean;
    /** Restart over an earlier world's database and Happy home. */
    readonly after?: MobileConnectorWorld;
    /** Leave the API's transport unattached, as before the daemon listens. */
    readonly detached?: boolean;
}

/**
 * Where the exposure forwards. The relay dials it only for a connection, and these tests reach
 * the module directly instead, so nothing listens there.
 */
export const UNUSED_TRANSPORT = { host: "127.0.0.1", port: 9 } as const;

/**
 * A real config, Durable Functions, Tailcat, and mobile connector over one in-memory database. The
 * only fake is the Tailcat executable, which publishes a fixed address and keeps running. The API
 * is not here: phones reach the module through `moduleTransport`, and the gym covers HTTP.
 */
export async function mobileConnectorWorld(
    options: MobileConnectorWorldOptions,
): Promise<MobileConnectorWorld> {
    const root = options.after?.root ?? (await mkdtemp(join(tmpdir(), "happy-mobile-connector-")));
    // A daemon running on this machine may hold any fixed port, so each world takes a free one.
    const port = options.port ?? (await freePort());
    const configDirectory = join(
        root,
        process.platform === "darwin" ? "Happy/Config" : "happy/config",
    );
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
        join(configDirectory, "happy.toml"),
        [
            "[feature.mobile_connector]",
            `enabled = ${String(options.enabled ?? true)}`,
            `port = ${String(port)}`,
        ].join("\n"),
    );
    const executable = join(root, "fake-tailcat");
    await writeFile(
        executable,
        `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, "tailcat-invocations"))}, args.join(" ") + "\\n");
if (args[0] === "genkey") {
    const key = args.find((argument) => argument.startsWith("--key="))?.slice(6);
    writeFileSync(key, "stable-private-key\\n", { mode: 0o600 });
    process.exit(0);
}
writeFileSync(process.env.TAILCAT_ADDR_FILE, ${JSON.stringify(`${FAKE_TAILCAT_ADDRESS}\n`)}, { mode: 0o600 });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => undefined, 1_000);
`,
    );
    await chmod(executable, 0o755);
    vi.stubEnv("HAPPY_AGENT_TAILCAT_PATH", executable);

    const config = await ConfigModule.load(join(root, ".happy"));
    const durableModule = new DurableFunctionsModule();
    const database =
        options.after?.database ??
        moduleDatabase(
            [...durableModule.migrations, ...mobileConnectorMigrations],
            "mobile-connector",
        );
    ensureAgentDatabaseConnection(database.database);
    await database.ready;
    const durable = await durableFunctionsHarness("mobile-connector", {
        database,
        module: durableModule,
        start: false,
    });
    const bots = { forAgent: async () => undefined } as unknown as BotsModule;
    const tailcat = new TailcatModule(config, bots, durable.module);
    const node = {
        get: async () => ({ name: "Test Mac", avatar: null }),
    } as unknown as NodeModule;
    const mobile = new MobileConnectorModule(
        config,
        team(options.team ?? false),
        node,
        tailcat,
        durable.module,
    );
    tailcat.beforeStart(database.context);
    const hooks: AgentModuleHooks = mobile.beforeStart(database.context);
    const events: MobileConnectorEvent[] = [];
    mobile.onEvent((_ctx, event) => {
        events.push(event);
    });
    await durable.start();
    await hooks.afterStart?.(database.context, {} as never);
    if (options.detached !== true) mobile.attachTransport(database.context, UNUSED_TRANSPORT);

    let stopped = false;
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        await mobile.close(database.context);
        await tailcat.close(database.context);
        durable.module.stop();
    };
    return {
        ctx: database.context,
        database,
        events,
        mobile,
        port,
        root,
        tailcat,
        stop,
        close: async () => {
            await stop();
            database.close();
            await rm(root, { force: true, recursive: true });
        },
    };
}

async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (address === null || typeof address === "string") throw new Error("No port is free.");
    return address.port;
}

function team(enabled: boolean): TeamModule {
    return new TeamModule(
        {
            configuration: {
                values: {
                    feature: {
                        team: {
                            authentication: "workos",
                            enabled,
                            host: "127.0.0.1",
                            ownerWorkOSUserId: "user_01TESTUSER123",
                            port: 3_000,
                            workosClientId: "client_test123",
                            workosOrganizationId: "org_01TESTORG123",
                        },
                    },
                },
            },
        } as never,
        testProfileModule(),
    );
}
