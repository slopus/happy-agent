import {
    type Applet,
    type AppletCatalog,
    type AppletCatalogCreateInput,
    type AppletCatalogMutationProof,
    type AppletCatalogMutationReceipt,
    type AppletCatalogMutationResult,
    type AppletCatalogRevertInput,
    type AppletCatalogUpdateInput,
    type AppletCurrentResult,
    type AppletListPage,
    assertApplet,
    assertAppletMutationProof,
    assertAppletMutationReceipt,
} from "@slopus/happy-agent-features";
import type { Context } from "@steve.kite/stdlib";
import { and, eq, gt, sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";
import {
    appletCatalogMutationProofSchema,
    appletCatalogMutationReceiptSchema,
} from "@slopus/happy-agent-features";

import {
    appletMutationProofs,
    appletMutationReceipts,
    applets,
    appletVersions,
} from "../database/schema.js";
import type { SessionDatabase } from "../database/SessionDatabase.js";
import {
    deferSessionTransactionCommit,
    deferSessionTransactionRollback,
    runSessionTransaction,
} from "../database/SessionTransactionContext.js";
import { withDatabase } from "../databaseContext.js";
import { queryApplet } from "./queryApplet.js";

/** Structural SQL port used by the feature-owned applet implementation. */
export class RigAppletCatalog implements AppletCatalog {
    readonly #database: SessionDatabase;

    constructor(database: SessionDatabase) {
        this.#database = database;
    }

    async transaction(
        ctx: Context,
        work: (ctx: Context) => Promise<unknown>,
    ): Promise<unknown> {
        return await runSessionTransaction(withDatabase(ctx, this.#database), work);
    }

    afterCommit(ctx: Context, callback: (ctx: Context) => void | Promise<void>): void {
        void deferSessionTransactionCommit(() => callback(ctx), this.#database);
    }

    onRollback(ctx: Context, callback: (ctx: Context) => void | Promise<void>): void {
        deferSessionTransactionRollback(() => callback(ctx), this.#database);
    }

    async list(
        ctx: Context,
        query: { readonly cursor?: string; readonly limit: number },
    ): Promise<AppletListPage> {
        const databaseCtx = withDatabase(ctx, this.#database);
        const rows = await databaseCtx.tx.all<{ name: string }>(
            query.cursor === undefined
                ? sql`SELECT name FROM applets ORDER BY name ASC LIMIT ${query.limit + 1}`
                : sql`SELECT name FROM applets WHERE name > ${query.cursor} ORDER BY name ASC LIMIT ${query.limit + 1}`,
        );
        const hasMore = rows.length > query.limit;
        const selected = rows.slice(0, query.limit);
        const found: Applet[] = [];
        for (const row of selected) {
            const applet = await queryApplet(databaseCtx, row.name);
            if (applet === undefined) {
                throw new Error(`Applet catalog row ${JSON.stringify(row.name)} disappeared.`);
            }
            assertApplet(applet);
            found.push(applet);
        }
        return {
            applets: found,
            limit: query.limit,
            hasMore,
            ...(hasMore ? { nextCursor: found.at(-1)!.name } : {}),
        } as AppletListPage;
    }

    async get(ctx: Context, name: string): Promise<Applet | undefined> {
        const applet = await queryApplet(withDatabase(ctx, this.#database), name);
        if (applet !== undefined) assertApplet(applet);
        return applet;
    }

    async create(
        ctx: Context,
        input: AppletCatalogCreateInput,
    ): Promise<AppletCatalogMutationResult> {
        const tx = withDatabase(ctx, this.#database).tx;
        await tx
            .insert(applets)
            .values({
                allowedScopesJson: JSON.stringify(input.allowedScopes ?? ["global"]),
                authorSessionId: input.authorSessionId,
                createdAtMs: input.initialVersion.createdAt,
                currentVersion: 1,
                description: input.description,
                iconThumbhash: input.iconThumbhash ?? "",
                name: input.name,
                purpose: input.purpose,
                sourceDescription: input.sourceDescription ?? null,
                updatedAtMs: input.initialVersion.createdAt,
            })
            .run();
        await tx
            .insert(appletVersions)
            .values({
                appletName: input.name,
                changeDescription: input.initialVersion.changeDescription,
                createdAtMs: input.initialVersion.createdAt,
                operationId: input.operationId,
                version: 1,
            })
            .run();
        const applet = await this.#require(ctx, input.name);
        return {
            operation: "create",
            name: input.name,
            operationId: input.operationId,
            targetVersion: 1,
            currentVersion: 1,
            changed: true,
            applet,
        };
    }

    async update(
        ctx: Context,
        name: string,
        input: AppletCatalogUpdateInput,
    ): Promise<AppletCatalogMutationResult> {
        const tx = withDatabase(ctx, this.#database).tx;
        await tx
            .insert(appletVersions)
            .values({
                appletName: name,
                changeDescription: input.changeDescription,
                createdAtMs: input.createdAt,
                operationId: input.operationId,
                version: input.version,
            })
            .run();
        await tx
            .update(applets)
            .set({
                currentVersion: input.version,
                updatedAtMs: input.createdAt,
                ...(input.allowedScopes === undefined
                    ? {}
                    : { allowedScopesJson: JSON.stringify(input.allowedScopes) }),
                ...(input.description === undefined ? {} : { description: input.description }),
                ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
                ...(input.sourceDescription === undefined
                    ? {}
                    : { sourceDescription: input.sourceDescription }),
                ...(input.iconThumbhash === undefined
                    ? {}
                    : { iconThumbhash: input.iconThumbhash }),
            })
            .where(eq(applets.name, name))
            .run();
        const applet = await this.#require(ctx, name);
        return {
            operation: "update",
            name,
            operationId: input.operationId,
            targetVersion: input.version,
            currentVersion: applet.currentVersion,
            changed: true,
            applet,
        };
    }

    async revert(
        ctx: Context,
        name: string,
        input: AppletCatalogRevertInput,
    ): Promise<AppletCatalogMutationResult> {
        const before = await this.#require(ctx, name);
        const changed = before.currentVersion !== input.version;
        if (changed) {
            await withDatabase(ctx, this.#database).tx
                .update(applets)
                .set({ currentVersion: input.version })
                .where(eq(applets.name, name))
                .run();
        }
        const applet = await this.#require(ctx, name);
        return {
            operation: "revert",
            name,
            operationId: input.operationId,
            targetVersion: input.version,
            currentVersion: applet.currentVersion,
            changed,
            applet,
        };
    }

    async remove(
        ctx: Context,
        name: string,
        operationId: string,
    ): Promise<AppletCatalogMutationResult> {
        const before = await this.get(ctx, name);
        if (before !== undefined) {
            await withDatabase(ctx, this.#database).tx
                .delete(applets)
                .where(eq(applets.name, name))
                .run();
        }
        return {
            operation: "remove",
            name,
            operationId,
            targetVersion: 0,
            currentVersion: 0,
            changed: before !== undefined,
            removed: before !== undefined,
        };
    }

    async readReceipt(
        ctx: Context,
        operationId: string,
    ): Promise<AppletCatalogMutationReceipt | undefined> {
        const row = await withDatabase(ctx, this.#database).tx.query.appletMutationReceipts.findFirst(
            { where: eq(appletMutationReceipts.operationId, operationId) },
        );
        if (row === undefined) return undefined;
        const value: unknown = JSON.parse(row.receiptJson);
        if (!Value.Check(appletCatalogMutationReceiptSchema, value)) {
            throw new Error("Stored applet mutation receipt is invalid.");
        }
        assertAppletMutationReceipt(value);
        return value;
    }

    async writeReceipt(ctx: Context, receipt: AppletCatalogMutationReceipt): Promise<void> {
        assertAppletMutationReceipt(receipt);
        await withDatabase(ctx, this.#database).tx
            .insert(appletMutationReceipts)
            .values({ operationId: receipt.operationId, receiptJson: JSON.stringify(receipt) })
            .run();
    }

    async readMutationProof(
        ctx: Context,
        operationId: string,
    ): Promise<AppletCatalogMutationProof | undefined> {
        const row = await withDatabase(ctx, this.#database).tx.query.appletMutationProofs.findFirst({
            where: eq(appletMutationProofs.operationId, operationId),
        });
        if (row === undefined) return undefined;
        const value: unknown = JSON.parse(row.proofJson);
        if (!Value.Check(appletCatalogMutationProofSchema, value)) {
            throw new Error("Stored applet mutation proof is invalid.");
        }
        assertAppletMutationProof(value);
        return value;
    }

    async writeMutationProof(ctx: Context, proof: AppletCatalogMutationProof): Promise<void> {
        assertAppletMutationProof(proof);
        await withDatabase(ctx, this.#database).tx
            .insert(appletMutationProofs)
            .values({ operationId: proof.operationId, proofJson: JSON.stringify(proof) })
            .run();
    }

    async current(ctx: Context, name: string): Promise<AppletCurrentResult> {
        const applet = await this.get(ctx, name);
        return applet?.versions.find((version) => version.version === applet.currentVersion);
    }

    async #require(ctx: Context, name: string): Promise<Applet> {
        const applet = await this.get(ctx, name);
        if (applet === undefined) throw new Error(`Applet "${name}" was not found.`);
        return applet;
    }
}