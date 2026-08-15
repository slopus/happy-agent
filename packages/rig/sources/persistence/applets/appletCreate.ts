import { applets, appletVersions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";
import type { AppletAllowedScopes } from "../../protocol/AppletProtocol.js";

export interface AppletCreateRecord {
    allowedScopes: AppletAllowedScopes;
    authorSessionId: string;
    changeDescription: string;
    createdAt: number;
    description: string;
    iconThumbhash: string;
    name: string;
    operationId?: string;
    purpose: string;
    sourceDescription?: string;
}

/** Writes the applet identity together with its first version so neither exists alone. */
export async function appletCreate(ctx: Context, record: AppletCreateRecord): Promise<void> {
    await inTx(ctx, "rig.sql.applets.create", async (ctx) => {
        const transaction = ctx.tx;
        await transaction
            .insert(applets)
            .values({
                allowedScopesJson: JSON.stringify(record.allowedScopes),
                authorSessionId: record.authorSessionId,
                createdAtMs: record.createdAt,
                currentVersion: 1,
                description: record.description,
                iconThumbhash: record.iconThumbhash,
                name: record.name,
                purpose: record.purpose,
                sourceDescription: record.sourceDescription ?? null,
                updatedAtMs: record.createdAt,
            })
            .run();
        await transaction
            .insert(appletVersions)
            .values({
                changeDescription: record.changeDescription,
                createdAtMs: record.createdAt,
                operationId: record.operationId ?? `legacy:${record.name}:1`,
                version: 1,
                appletName: record.name,
            })
            .run();
    });
}
import type { Context } from "@steve.kite/stdlib";
