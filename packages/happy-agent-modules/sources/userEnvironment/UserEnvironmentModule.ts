import type {
    AgentBaseSystemNotificationBoundary,
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AgentSystemRef,
} from "@slopus/happy-agent-base";
import type { SessionSystemMessage } from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { TasksModule } from "../tasks/index.js";
import { TeamAuthenticationError, type TeamModule, teamUser } from "../team/index.js";

import { environmentChangeNotice, environmentNotice } from "./impl/environmentNotices.js";
import { mergeUserEnvironment } from "./impl/mergeUserEnvironment.js";
import { changedAspects, toldEnvironment, toldEnvironmentSchema } from "./impl/toldEnvironment.js";
import { queryLatestUserDeviceEnvironment } from "./persistence/queryLatestUserDeviceEnvironment.js";
import { queryUserDeviceEnvironment } from "./persistence/queryUserDeviceEnvironment.js";
import { saveUserDeviceEnvironment } from "./persistence/saveUserDeviceEnvironment.js";
import {
    STANDALONE_USER_ENVIRONMENT_OWNER,
    USER_DEVICE_STALE_AFTER_MS,
    userDeviceIdSchema,
    userEnvironmentReportSchema,
    type StoredUserEnvironment,
    type UserEnvironmentOwner,
    type UserEnvironmentReport,
    type UserEnvironmentReportResult,
} from "./UserEnvironment.js";
import { UserEnvironmentError } from "./UserEnvironmentError.js";
import { userEnvironmentMigrations } from "./UserEnvironmentMigrations.js";

/** What this agent was last told, and from which device, in its own store. */
const TOLD_KEY = "environment";
const toldSchema = Type.Object(
    { deviceId: userDeviceIdSchema, environment: toldEnvironmentSchema },
    { additionalProperties: false },
);
/** The message metadata key naming the device a person sent a message from. */
const DEVICE_METADATA_KEY = "deviceId";
/** Parentage is a tree, but a damaged link must not walk forever. */
const MAX_PARENT_DEPTH = 64;

/**
 * The environment each of a person's devices reports: time zone, languages, clock, week, and
 * calendar. Every device keeps its own record, so two devices set up differently never overwrite
 * each other, and each report replaces only the fields it carries in that device's record.
 *
 * The owner of a report comes from the caller's context: a team member's local user ID, or the
 * standalone installation's one person. The device is named by its client, because no credential
 * the daemon verifies identifies one device across every transport.
 *
 * When a message is accepted for one of that person's agents, the environment of the device the
 * message came from — or, for a message from no device, of the device that reported most recently
 * in the last 30 days — is compared with what the agent was last told, in the same transaction.
 * An agent never told receives the whole environment once; one told something else receives what
 * changed once, and which device the person moved to. Nothing wakes an idle agent.
 */
export class UserEnvironmentModule implements AgentModule {
    readonly name = "userEnvironment";
    readonly migrations = userEnvironmentMigrations;

    readonly #team: TeamModule;
    readonly #tasks: TasksModule;
    #agents: AgentSystemRef | undefined;

    constructor(team: TeamModule, tasks: TasksModule) {
        this.#team = team;
        this.#tasks = tasks;
    }

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return {
            systemNotificationsTransact: async (ctx, scope, boundary) =>
                boundary.type === "message"
                    ? await this.#notices(ctx, scope, messageDevice(boundary))
                    : undefined,
        };
    };

    /**
     * The environment agents of the caller use for a message from `deviceId`: that device's, or
     * with none, the one that reported most recently and is not stale.
     */
    async environment(ctx: Context, deviceId?: string): Promise<StoredUserEnvironment | undefined> {
        return await this.#effective(ctx, this.#owner(ctx), deviceId);
    }

    /**
     * Record what one of the caller's devices reports. Every report counts as the device being
     * seen, even one that changes nothing. A malformed field, unknown time zone, or malformed
     * language tag throws `UserEnvironmentError`.
     */
    async report(
        ctx: Context,
        report: UserEnvironmentReport,
    ): Promise<UserEnvironmentReportResult> {
        if (!Value.Check(userEnvironmentReportSchema, report)) {
            throw new UserEnvironmentError("The reported environment is invalid.");
        }
        const owner = this.#owner(ctx);
        return await ctx.inTx(async (txCtx) => {
            const now = Date.now();
            const { deviceId } = report;
            const stored = await queryUserDeviceEnvironment(txCtx, owner, deviceId);
            const environment = mergeUserEnvironment(stored?.environment, report);
            const same = stored !== undefined && Value.Equal(stored.environment, environment);
            const kind = report.deviceKind ?? stored?.deviceKind;
            const result: StoredUserEnvironment = {
                deviceId,
                ...(kind === undefined ? {} : { deviceKind: kind }),
                environment,
                updatedAt: same ? stored.updatedAt : now,
                reportedAt: now,
            };
            await saveUserDeviceEnvironment(txCtx, owner, result, now - USER_DEVICE_STALE_AFTER_MS);
            const changed = changedAspects(
                toldEnvironment(stored?.environment ?? {}),
                toldEnvironment(environment),
            );
            return { ...result, changed };
        });
    }

    async #notices(
        ctx: Context,
        scope: AgentModuleScope,
        deviceId: string | undefined,
    ): Promise<readonly SessionSystemMessage[] | undefined> {
        const owner = await this.#agentOwner(ctx, scope.agent.id);
        if (owner === undefined) return;
        const device = await this.#effective(ctx, owner, deviceId);
        if (device === undefined) return;
        const current = toldEnvironment(device.environment);
        if (Object.keys(current).length === 0) return;
        const told = await scope.kv.read(ctx, TOLD_KEY);
        if (told !== undefined && !Value.Check(toldSchema, told)) {
            throw new Error("The environment this agent was last told is invalid.");
        }
        if (
            told?.deviceId === device.deviceId &&
            changedAspects(told.environment, current).length === 0
        ) {
            return;
        }
        await scope.kv.write(ctx, TOLD_KEY, { deviceId: device.deviceId, environment: current });
        if (told === undefined) return [environmentNotice(current, device.deviceKind, Date.now())];
        // Moving to a device that agrees is no news; the agent only learns which device it is.
        if (changedAspects(told.environment, current).length === 0) return;
        const moved = told.deviceId === device.deviceId ? undefined : device.deviceKind;
        return [environmentChangeNotice(told.environment, current, moved, Date.now())];
    }

    async #effective(
        ctx: Context,
        owner: UserEnvironmentOwner,
        deviceId: string | undefined,
    ): Promise<StoredUserEnvironment | undefined> {
        const named =
            deviceId === undefined
                ? undefined
                : await queryUserDeviceEnvironment(ctx, owner, deviceId);
        return (
            named ??
            (await queryLatestUserDeviceEnvironment(
                ctx,
                owner,
                Date.now() - USER_DEVICE_STALE_AFTER_MS,
            ))
        );
    }

    #owner(ctx: Context): UserEnvironmentOwner {
        if (!this.#team.enabled) return STANDALONE_USER_ENVIRONMENT_OWNER;
        const user = teamUser(ctx);
        if (user === undefined) throw new TeamAuthenticationError();
        return user.id;
    }

    /**
     * Standalone, every agent belongs to the installation's one person. In team mode an agent
     * belongs to the owner of the task at the root of its tree; bots are shared and have none.
     */
    async #agentOwner(ctx: Context, agentId: string): Promise<UserEnvironmentOwner | undefined> {
        if (!this.#team.enabled) return STANDALONE_USER_ENVIRONMENT_OWNER;
        const agents = this.#agents;
        if (agents === undefined) throw new Error("User environment has not started.");
        let root = agentId;
        for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
            const parent = await agents.parentOf(ctx, root);
            if (parent === null) return (await this.#tasks.forAgent(ctx, root))?.ownerUserId;
            root = parent;
        }
        return undefined;
    }
}

/** The device a message names in its metadata; anything malformed names none. */
function messageDevice(
    boundary: Extract<AgentBaseSystemNotificationBoundary, { type: "message" }>,
): string | undefined {
    const deviceId = boundary.accepted.metadata?.[DEVICE_METADATA_KEY];
    return Value.Check(userDeviceIdSchema, deviceId) ? deviceId : undefined;
}
