import type { AgentModule, AgentModuleHooks } from "@slopus/happy-agent-base";
import { nodeNameSchema, type NodeConfig } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";
import { BotsModule } from "../bots/index.js";
import { ConfigModule } from "../config/index.js";
import { ComputeModule } from "../compute/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { MAX_NODE_AVATAR_BYTES, type NodeAvatarAsset, type NodeState } from "./NodeState.js";
import { nodeMigrations, queryNodeState, saveNodeState } from "./persistence/nodeState.js";
import { normalizeNodeAvatar } from "./impl/normalizeNodeAvatar.js";
import { setNodeNameTool } from "./tools/set_node_name.js";
import { setNodeAvatarTool } from "./tools/set_node_avatar.js";

const SAVE_RUNTIME_NAME = "node-save-runtime-name";
type NodeListener = (ctx: Context) => void | Promise<void>;

/** Owns installation display configuration, bounded avatar storage, and active-admin tools. */
export class NodeModule implements AgentModule {
    readonly name = "node";
    readonly migrations = nodeMigrations;
    readonly #config: ConfigModule;
    readonly #bots: BotsModule;
    readonly #compute: ComputeModule;
    readonly #durable: DurableFunctionsModule;
    readonly #transactional = new Set<NodeListener>();
    readonly #listeners = new Set<NodeListener>();

    constructor(
        config: ConfigModule,
        bots: BotsModule,
        compute: ComputeModule,
        durable: DurableFunctionsModule,
    ) {
        this.#config = config;
        this.#bots = bots;
        this.#compute = compute;
        this.#durable = durable;
        durable.register({
            name: SAVE_RUNTIME_NAME,
            argumentsSchema: Type.Object({}, { additionalProperties: false }),
            resultSchema: Type.Null(),
            executor: async (ctx) => {
                // Read current state instead of replaying a possibly superseded name from the call.
                const node = await this.get(ctx);
                await this.#config.writeRuntimeNodeName(ctx, node.name);
                return null;
            },
        });
    }

    readonly beforeStart = async (ctx: Context): Promise<AgentModuleHooks> => {
        const initialName = await this.#config.initialNodeName();
        await ctx.inTx(async (txCtx) => {
            if ((await queryNodeState(txCtx)) === undefined) {
                await saveNodeState(txCtx, { name: initialName, avatar: null });
            }
            await this.#scheduleRuntimeWrite(txCtx);
        });
        return {
            tools: async (toolCtx, scope) =>
                (await this.#isAdmin(toolCtx, scope.agent.id))
                    ? [
                          setNodeNameTool(this, scope.agent.id),
                          setNodeAvatarTool(this, scope.agent.id),
                      ]
                    : [],
        };
    };

    onUpdated(listener: NodeListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    onUpdatedTransactional(listener: NodeListener): () => void {
        this.#transactional.add(listener);
        return () => {
            this.#transactional.delete(listener);
        };
    }

    async get(ctx: Context): Promise<NodeConfig> {
        return await ctx.inTx(async (txCtx) => project(await this.#read(txCtx)));
    }

    async avatar(ctx: Context): Promise<NodeAvatarAsset | null> {
        return await ctx.inTx(async (txCtx) => (await this.#read(txCtx)).avatar);
    }

    /** HTTP authorization is owned by API; this operation also composes inside a caller transaction. */
    async setName(ctx: Context, name: string): Promise<NodeConfig> {
        if (!Value.Check(nodeNameSchema, name))
            throw new Error("The node name must contain 1–128 printable characters.");
        return await ctx.inTx(async (txCtx) => {
            const state = await this.#read(txCtx);
            if (state.name === name) return project(state);
            const next = { ...state, name };
            await saveNodeState(txCtx, next);
            await this.#scheduleRuntimeWrite(txCtx);
            await this.#updated(txCtx);
            return project(next);
        });
    }

    async setNameForAdmin(ctx: Context, agentId: string, name: string): Promise<NodeConfig> {
        return await ctx.inTx(async (txCtx) => {
            await this.requireAdmin(txCtx, agentId);
            return await this.setName(txCtx, name);
        });
    }

    async shouldElevateImageRead(
        ctx: Context,
        agentId: string,
        path: string | null,
    ): Promise<boolean> {
        if (path === null) return false;
        const compute = await this.#compute.resolve(ctx, agentId);
        return (
            compute === undefined ||
            (await this.#compute.shouldReviewPath(ctx, compute, path, { write: false }))
        );
    }

    /** Read only through the same per-action filesystem boundary used by every vendor tool. */
    async setAvatarFromPath(
        ctx: Context,
        agentId: string,
        path: string | null,
    ): Promise<NodeConfig> {
        await this.requireAdmin(ctx, agentId);
        let asset: NodeAvatarAsset | null = null;
        if (path !== null) {
            const compute = await this.#compute.resolve(ctx, agentId);
            if (compute === undefined) throw new Error("The agent's filesystem is unavailable.");
            const permissions = this.#compute.permissionsForContext(ctx);
            const facts = await compute.fs.stat(permissions, path);
            if (!facts.isFile || facts.size === 0 || facts.size > MAX_NODE_AVATAR_BYTES) {
                throw new Error("The node avatar must be an image file no larger than 8 MiB.");
            }
            const bytes = await compute.fs.readFileBuffer(permissions, path, {
                maxBytes: MAX_NODE_AVATAR_BYTES,
            });
            asset = await normalizeNodeAvatar(bytes);
        }
        return await ctx.inTx(async (txCtx) => {
            await this.requireAdmin(txCtx, agentId);
            const state = await this.#read(txCtx);
            if (state.avatar?.etag === asset?.etag) return project(state);
            const next = { ...state, avatar: asset };
            await saveNodeState(txCtx, next);
            await this.#updated(txCtx);
            return project(next);
        });
    }

    async requireAdmin(ctx: Context, agentId: string): Promise<void> {
        if (!(await this.#isAdmin(ctx, agentId)))
            throw new Error(
                "Only an active admin bot can change this installation's name or avatar.",
            );
    }

    async #isAdmin(ctx: Context, agentId: string): Promise<boolean> {
        const bot = await this.#bots.forAgent(ctx, agentId);
        return bot?.isAdmin === true && bot.status === "active";
    }

    async #read(ctx: Context): Promise<NodeState> {
        const state = await queryNodeState(ctx);
        if (state === undefined) throw new Error("Node configuration has not started.");
        return state;
    }

    async #scheduleRuntimeWrite(ctx: Context): Promise<void> {
        await this.#durable.invoke(ctx, {
            function: SAVE_RUNTIME_NAME,
            arguments: {},
            lockKeys: [SAVE_RUNTIME_NAME],
        });
    }

    async #updated(ctx: Context): Promise<void> {
        for (const listener of this.#transactional) await listener(ctx);
        afterCommit(ctx, async (committedCtx) => {
            for (const listener of this.#listeners) await listener(committedCtx);
        });
    }
}

function project(state: NodeState): NodeConfig {
    return {
        name: state.name,
        avatar: state.avatar === null ? null : { thumbhash: state.avatar.thumbhash },
    };
}
