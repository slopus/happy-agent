import { randomUUID } from "node:crypto";

import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentModule,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import { ProjectsModule } from "../projects/index.js";

interface Installation {
    readonly epoch: string;
    readonly schemaVersion: number;
}

/** Establishes the durable identity and schema generation of this runtime's private root. */
export class InstallationModule implements AgentModule<AnyAgentTool, LibSQLDatabase> {
    readonly name = "happy-agent-installation";
    readonly migrations = [
        [
            "001-root-agent",
            async (_ctx: Context, database: AgentDatabase) => {
                await agentDatabaseRun(
                    database,
                    sql`CREATE TABLE IF NOT EXISTS happy_agent_loader_state (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    )`,
                );
            },
        ],
        [
            "002-drop-root-agent",
            async (_ctx: Context, database: AgentDatabase) => {
                await agentDatabaseRun(
                    database,
                    sql`DELETE FROM happy_agent_loader_state WHERE key = 'root_agent_id'`,
                );
            },
        ],
    ] as const satisfies AgentModule<AnyAgentTool, LibSQLDatabase>["migrations"];

    readonly #projects: ProjectsModule;
    #installation: Installation | undefined;

    constructor(projects: ProjectsModule) {
        this.#projects = projects;
    }

    readonly beforeStart = async (ctx: Context): Promise<void> => {
        this.#installation = await ctx.inTx(async (txCtx) => await readInstallation(txCtx.db));
        this.#projects.open(this.#installation.epoch);
    };

    get epoch(): string {
        return this.#read().epoch;
    }

    get schemaVersion(): number {
        return this.#read().schemaVersion;
    }

    #read(): Installation {
        if (this.#installation === undefined) {
            throw new Error("The Happy agent installation was not established while starting.");
        }
        return this.#installation;
    }
}

async function readInstallation(database: AgentDatabase): Promise<Installation> {
    const rows = await agentDatabaseRows<{ key: string; value: string }>(
        database,
        sql`SELECT key, value FROM happy_agent_loader_state
            WHERE key IN ('installation_epoch', 'schema_version')`,
    );
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const epoch = values.get("installation_epoch") ?? randomUUID();
    const storedVersion = values.get("schema_version");
    const schemaVersion = storedVersion === undefined ? 1 : Number.parseInt(storedVersion, 10);
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
        throw new Error("The stored Happy agent schema version is invalid.");
    }
    for (const [key, value] of [
        ["installation_epoch", epoch],
        ["schema_version", String(schemaVersion)],
    ] as const) {
        if (values.has(key)) continue;
        await agentDatabaseRun(
            database,
            sql`INSERT INTO happy_agent_loader_state (key, value) VALUES (${key}, ${value})`,
        );
    }
    return { epoch, schemaVersion };
}
