import type {
    AgentModuleHooks,
    AgentModuleScope,
    AgentSystemRef,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import type { ArtifactsModule } from "../artifacts/index.js";
import { GEN_UI_RENDER_PRIMITIVES } from "../impl/genUi/genUiSchemas.js";
import {
    SecretApiConflictError,
    type SecretApiRecord,
    type SecretsModule,
} from "../secrets/index.js";
import {
    SecretActionError,
    type SecretActionSaveRequest,
    type SecretActionSaveResult,
} from "./SecretAction.js";
import { SECRET_ACTION_SAVES_TABLE, secretRequestsMigrations } from "./SecretRequestsMigrations.js";
import { requestSecretTool } from "./tools/request_secret.js";

const RENDER_PATH = ".genui/render.json";

const archivedAgentMetadataSchema = Type.Object({ archivedAt: Type.Number() });

/** The part of a stored `secret` action the save reads: what the agent asked for. */
const secretActionSchema = Type.Object({
    type: Type.Literal("secret"),
    secret: Type.Object({
        variables: Type.Array(Type.Object({ name: Type.String() })),
    }),
});

const renderElementSchema = Type.Object({ type: Type.String(), props: Type.Unknown() });
const renderDocumentSchema = Type.Object({
    elements: Type.Record(Type.String(), Type.Unknown()),
});

interface SaveRow {
    readonly artifact_id: string;
    readonly version: number;
    readonly element: string;
    readonly secret_id: string;
    readonly outcome: "created" | "updated";
}

/**
 * Asking a person for a Happy Agent secret through Gen UI. `request_secret` publishes a card whose
 * button carries a `secret` action; the person's saved form comes back through
 * `saveSecretAction`, which stores the secret, attaches it to the agent that made the card, and
 * tells that agent, in one transaction. Values pass straight to the secrets module and appear in
 * nothing this module stores, returns, or says.
 */
export class SecretRequestsModule {
    readonly name = "secret-requests";
    readonly migrations = secretRequestsMigrations;

    readonly #artifacts: ArtifactsModule;
    readonly #secrets: SecretsModule;
    #agents: AgentSystemRef | undefined;

    constructor(artifacts: ArtifactsModule, secrets: SecretsModule) {
        this.#artifacts = artifacts;
        this.#secrets = secrets;
    }

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return {
            tools: (_toolCtx: Context, scope: AgentModuleScope): readonly AnyAgentTool[] => [
                requestSecretTool(this.#artifacts, this.#secrets, scope.agent.id),
            ],
        };
    };

    /** Save the form a person filled in from one element's `secret` action. */
    async saveSecretAction(
        ctx: Context,
        artifactId: string,
        version: number,
        request: SecretActionSaveRequest,
    ): Promise<SecretActionSaveResult> {
        const agents = this.#agents;
        if (agents === undefined) throw new Error("Secret requests are not started.");
        const asked = await this.#storedAction(ctx, artifactId, version, request.element);
        return await ctx.inTx(async (txCtx) => {
            const earlier = await this.#earlierSave(txCtx, request.id);
            if (earlier !== undefined) {
                if (
                    earlier.artifact_id !== artifactId ||
                    earlier.version !== version ||
                    earlier.element !== request.element
                ) {
                    throw new SecretActionError(
                        "conflict",
                        "This save ID was already used for another element.",
                    );
                }
                const secret = await this.#secrets.catalogSecret(txCtx, earlier.secret_id);
                if (secret === undefined) {
                    throw new SecretActionError("not_found", "The saved secret was deleted.");
                }
                return { secret, outcome: earlier.outcome };
            }
            const config = await agents.config(txCtx, asked.agentId);
            if (config === undefined || Value.Check(archivedAgentMetadataSchema, config.metadata)) {
                throw new SecretActionError(
                    "conflict",
                    "The agent that asked for this secret is archived.",
                );
            }
            const { secret, outcome } = await this.#store(txCtx, request);
            await this.#secrets.attachCatalogSecret(txCtx, secret.id, {
                type: "agent",
                id: asked.agentId,
            });
            const accepted = await agents.steer(
                txCtx,
                asked.agentId,
                {
                    role: "system",
                    content: [
                        {
                            type: "text",
                            text: savedNotice(secret, outcome, asked.variables, asked.title),
                        },
                    ],
                },
                { id: request.id },
            );
            if (accepted.id !== request.id) {
                throw new Error("Agent Base did not keep the save's message ID.");
            }
            await agentDatabaseRun(
                txCtx.db,
                sql`INSERT INTO ${sql.raw(SECRET_ACTION_SAVES_TABLE)}
                    (id, artifact_id, version, element, secret_id, agent_id, outcome, created_at)
                    VALUES (${request.id}, ${artifactId}, ${version}, ${request.element},
                    ${secret.id}, ${asked.agentId}, ${outcome}, ${Date.now()})`,
            );
            return { secret, outcome };
        });
    }

    /** The `secret` action an element of a stored render document carries, and who asked. */
    async #storedAction(
        ctx: Context,
        artifactId: string,
        version: number,
        element: string,
    ): Promise<{ agentId: string; title: string; variables: readonly string[] }> {
        const artifact = await this.#artifacts.get(ctx, artifactId);
        const stored = await this.#artifacts.getVersion(ctx, artifactId, version);
        if (
            artifact?.type !== "gen_ui" ||
            !stored.files.some((file) => file.path === RENDER_PATH)
        ) {
            throw new SecretActionError("invalid", "This version is not a Gen UI document.");
        }
        const read = await this.#artifacts.readFile(ctx, artifactId, version, RENDER_PATH, {
            maxBytes: 4 * 1024 * 1024,
        });
        const document: unknown = JSON.parse(new TextDecoder().decode(read.bytes));
        if (!Value.Check(renderDocumentSchema, document)) {
            throw new Error("The stored render document is malformed.");
        }
        const found = Object.hasOwn(document.elements, element)
            ? document.elements[element]
            : undefined;
        if (!Value.Check(renderElementSchema, found)) {
            throw new SecretActionError("not_found", "The element was not found.");
        }
        const primitive = GEN_UI_RENDER_PRIMITIVES.get(found.type);
        const action =
            (found.type === "button" || found.type === "press") &&
            primitive !== undefined &&
            Value.Check(primitive.props, found.props)
                ? (found.props as { action?: unknown }).action
                : undefined;
        if (!Value.Check(secretActionSchema, action)) {
            throw new SecretActionError("invalid", "The element does not ask for a secret.");
        }
        if (stored.createdBy.kind !== "agent") {
            throw new SecretActionError(
                "conflict",
                "No agent made this version, so there is no one to give the secret to.",
            );
        }
        return {
            agentId: stored.createdBy.agentId,
            title: stored.title,
            variables: action.secret.variables.map((variable) => variable.name),
        };
    }

    async #earlierSave(ctx: Context, id: string): Promise<SaveRow | undefined> {
        const rows = await agentDatabaseRows<SaveRow>(
            ctx.db,
            sql`SELECT artifact_id, version, element, secret_id, outcome
                FROM ${sql.raw(SECRET_ACTION_SAVES_TABLE)} WHERE id = ${id}`,
        );
        return rows[0];
    }

    /** Create the secret, or change the one the form showed when its version still matches. */
    async #store(
        ctx: Context,
        request: SecretActionSaveRequest,
    ): Promise<{ secret: SecretApiRecord; outcome: "created" | "updated" }> {
        const current = await this.#secrets.catalogSecret(ctx, request.secret.id);
        if (!("ifMatch" in request)) {
            if (current !== undefined) {
                throw new SecretApiConflictError("That secret ID is already in use.", current);
            }
            const secret = await this.#secrets.createCatalogSecret(ctx, request.secret);
            return { secret, outcome: "created" };
        }
        if (current === undefined) {
            throw new SecretActionError("conflict", "The secret no longer exists.");
        }
        if (!current.availableToAgents) {
            throw new SecretApiConflictError("This secret is not available to agents.", current);
        }
        const secret = await this.#secrets.updateCatalogSecret(ctx, current.id, request.ifMatch, {
            description: request.secret.description,
            environment: request.secret.environment,
        });
        if (secret === undefined) {
            throw new SecretActionError("conflict", "The secret no longer exists.");
        }
        return { secret, outcome: "updated" };
    }
}

/** What the agent is told: names only, never a value. */
function savedNotice(
    secret: SecretApiRecord,
    outcome: "created" | "updated",
    asked: readonly string[],
    title: string,
): string {
    const held = new Set(secret.environmentVariables.map((name) => name.toUpperCase()));
    const missing = asked.filter((name) => !held.has(name.toUpperCase()));
    return [
        `The user ${outcome === "created" ? "added" : "changed"} the secret ${JSON.stringify(secret.id)} from ${JSON.stringify(title)}. It holds ${secret.environmentVariables.join(", ")}.`,
        missing.length === 0 ? "" : ` It does not hold ${missing.join(", ")}, which you asked for.`,
        " It is attached to you: name it in a shell command's secrets argument to use it. You never see its values.",
    ].join("");
}
