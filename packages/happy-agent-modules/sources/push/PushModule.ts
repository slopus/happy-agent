import type {
    AgentKV,
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AgentSystemRef,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { requireDurableCommit } from "../impl/durableCommit.js";
import { MobileConnectorModule } from "../mobileConnector/index.js";
import { SubtasksModule } from "../subtasks/index.js";
import { TasksModule } from "../tasks/index.js";
import { TeamAuthenticationError, TeamModule, teamUser } from "../team/index.js";

import { pushRelayMessage } from "./impl/pushRelayMessage.js";
import { pushRelaySend } from "./impl/pushRelaySend.js";
import { deleteDevicePushRegistrations } from "./persistence/deleteDevicePushRegistrations.js";
import { deletePushRegistration } from "./persistence/deletePushRegistration.js";
import { queryLivePushRegistrations } from "./persistence/queryLivePushRegistrations.js";
import { queryPushSettings } from "./persistence/queryPushSettings.js";
import { savePushRegistration } from "./persistence/savePushRegistration.js";
import { savePushSettings } from "./persistence/savePushSettings.js";
import { PushError } from "./PushError.js";
import { pushMigrations } from "./PushMigrations.js";
import { pushNotificationSchema, type PushNotification } from "./PushNotification.js";
import {
    parsePushRegistrationInput,
    pushOwnerSchema,
    pushRegistrationIdSchema,
    parsePushRegistrationVersion,
    pushSettingsSchema,
    STANDALONE_PUSH_OWNER,
    type PushOwner,
    type PushRegistration,
    type PushSettings,
} from "./PushRegistration.js";
import { sendPushNotificationTool } from "./tools/send_push_notification.js";

const DELIVER_FUNCTION = "push.deliver";

/** Where a run keeps what its agent last asked the person to be told. */
const PENDING_KEY = "pending";
const pendingSchema = Type.Pick(pushNotificationSchema, ["notificationId", "title", "body"], {
    additionalProperties: false,
});

/** How far up its parents an agent is followed to the conversation a person started. */
const MAX_PARENT_DEPTH = 8;

const deliveryArgumentsSchema = Type.Object(
    { recipient: pushOwnerSchema, notification: pushNotificationSchema },
    { additionalProperties: false },
);
type DeliveryArguments = Static<typeof deliveryArgumentsSchema>;

/**
 * Which phones a person can be notified on, and delivery to them through Happy's push relay.
 *
 * A phone registers the relay capability for itself; in team mode it belongs to the authenticated
 * member, standalone to the installation's one person. Registration and settings take their owner
 * from the caller's context, so no caller can name another person's phone. `send` is the one way
 * to notify someone: it records the notification with the caller's transaction and delivers after
 * commit, once per phone, with no retry. The capability is never returned, logged, or announced.
 *
 * An agent a person can see says what happened with `send_push_notification`. The module keeps the
 * last thing said in the agent's run and sends it when that run settles, so nothing is sent while
 * the agent is still working and nothing at all for a run that was stopped, failed, or cut off by
 * a restart.
 *
 * A registration remembers the paired phone that made it. Unpairing that phone removes its
 * registrations in the same transaction, so nothing is sent to a phone its person took away.
 */
export class PushModule implements AgentModule {
    readonly name = "push";
    readonly migrations = pushMigrations;

    readonly #team: TeamModule;
    readonly #config: ConfigModule;
    readonly #durableFunctions: DurableFunctionsModule;
    readonly #tasks: TasksModule;
    readonly #subtasks: SubtasksModule;
    #agents: AgentSystemRef | undefined;

    constructor(
        team: TeamModule,
        config: ConfigModule,
        durableFunctions: DurableFunctionsModule,
        tasks: TasksModule,
        subtasks: SubtasksModule,
        mobileConnector: MobileConnectorModule,
    ) {
        this.#team = team;
        this.#config = config;
        this.#durableFunctions = durableFunctions;
        this.#tasks = tasks;
        this.#subtasks = subtasks;
        mobileConnector.onDeviceRemovedTransactional(async (ctx, removed) => {
            const count = await deleteDevicePushRegistrations(ctx, removed.owner, removed.deviceId);
            if (count === 0) return;
            ctx.log.info(
                `push:registration outcome=device_removed deviceId=${removed.deviceId} removed=${String(count)}`,
            );
        });
        durableFunctions.register({
            name: DELIVER_FUNCTION,
            argumentsSchema: deliveryArgumentsSchema,
            resultSchema: Type.Null(),
            executor: async (ctx, call) => {
                await this.#deliver(ctx, call.arguments, call.kv);
                return null;
            },
        });
    }

    readonly #hooks: AgentModuleHooks = {
        /** Only an agent a person can see and talk to may tell them something. */
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            if (!(await this.#userVisible(ctx, scope))) return [];
            return [
                sendPushNotificationTool(async (toolCtx, said) => {
                    // The last call of a run wins; nothing leaves before the run settles.
                    await scope.runKV.write(toolCtx, PENDING_KEY, {
                        notificationId: said.callId,
                        title: said.title,
                        body: said.subtitle ?? "",
                    } satisfies Static<typeof pendingSchema>);
                }),
            ];
        },

        /**
         * A run the last process left unfinished resumes here. What it had asked to say is
         * dropped: the person may have been back since, and a restart must never send a stale
         * notification. If the resumed run still has something to say, it says it again.
         */
        afterAgentActivatedTransact: async (ctx, scope, activation): Promise<void> => {
            if (activation.restored) await this.#drop(ctx, scope, "restarted");
        },

        /** A turn someone stopped did not end by the agent's choice, so it tells nobody. */
        afterTurnTransact: async (ctx, scope, turn): Promise<void> => {
            if (turn.aborted) await this.#drop(ctx, scope, "stopped");
        },

        /**
         * The agent has gone idle. What its run last said is handed to `send` in the transaction
         * that settles the run and erases the run's store, so it is sent once or not at all.
         */
        afterAgentSettledTransact: async (ctx, scope, settlement): Promise<void> => {
            const pending = await scope.runKV.read(ctx, PENDING_KEY);
            if (!Value.Check(pendingSchema, pending)) return;
            const unsent = (outcome: string): void => {
                ctx.log.info(
                    `push:notification outcome=${outcome} notificationId=${pending.notificationId} agentId=${scope.agent.id}`,
                );
            };
            if (settlement.error !== undefined) return unsent("run_failed");
            if (!(await this.#userVisible(ctx, scope))) return unsent("hidden_agent");
            const recipient = await this.#recipient(ctx, scope.agent.id);
            if (recipient === undefined) return unsent("no_recipient");
            await this.send(ctx, recipient, { ...pending, agentId: scope.agent.id });
        },
    };

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

    /**
     * Register the caller's phone under `id`, or renew it for another 30 days under a new
     * version. `request` is what the phone sent, unchecked. `pairedDeviceId` is the paired phone
     * the request authenticated as, when it came from one: unpairing that phone removes the
     * registration.
     */
    async register(
        ctx: Context,
        id: string,
        request: unknown,
        pairedDeviceId?: string,
    ): Promise<PushRegistration> {
        const owner = this.#owner(ctx);
        checkRegistrationId(id);
        const input = parsePushRegistrationInput(request);
        if (input === undefined) {
            throw new PushError("invalid_request", "The push registration is invalid.");
        }
        return await savePushRegistration(ctx, owner, id, input, pairedDeviceId, Date.now());
    }

    /**
     * Remove the caller's registration at exactly `version`. One that is already gone, someone
     * else's, or renewed since is left alone, and the call still succeeds.
     */
    async unregister(ctx: Context, id: string, version: string): Promise<void> {
        const owner = this.#owner(ctx);
        checkRegistrationId(id);
        const named = parsePushRegistrationVersion(version);
        if (named === undefined) {
            throw new PushError("invalid_request", "The registration version must be a UUID.");
        }
        await deletePushRegistration(ctx, owner, id, named);
    }

    /** Whether the server may notify the caller's phones. */
    async settings(ctx: Context): Promise<PushSettings> {
        return await queryPushSettings(ctx, this.#owner(ctx));
    }

    /** Replace the caller's push settings. `settings` is what the client sent, unchecked. */
    async saveSettings(ctx: Context, settings: unknown): Promise<PushSettings> {
        const owner = this.#owner(ctx);
        if (!Value.Check(pushSettingsSchema, settings)) {
            throw new PushError("invalid_request", "The push settings are invalid.");
        }
        await savePushSettings(ctx, owner, settings);
        return { enabled: settings.enabled };
    }

    /**
     * Notify one person on their phones. The notification is recorded with the caller's
     * transaction, so it is sent only if that commits, and it survives a restart. Whether the
     * person allows notifications and which phones are registered are read when it is delivered.
     * Notifications to one person are delivered in the order they were sent. A notification
     * outside the schema's bounds, a title of 1 to 80 characters and a body of at most 160, is
     * refused here and nothing is recorded.
     */
    async send(ctx: Context, recipient: PushOwner, notification: PushNotification): Promise<void> {
        if (!Value.Check(pushNotificationSchema, notification)) {
            throw new PushError(
                "invalid_request",
                "A notification needs a title of 1 to 80 characters and a body of at most 160.",
            );
        }
        await this.#durableFunctions.invoke(ctx, {
            function: DELIVER_FUNCTION,
            arguments: { recipient, notification } satisfies DeliveryArguments,
            lockKeys: [`push.recipient.${recipient}`],
        });
    }

    async #deliver(
        ctx: Context,
        { recipient, notification }: DeliveryArguments,
        attempts: AgentKV,
    ): Promise<void> {
        const unsent = (outcome: string): void => {
            ctx.log.info(
                `push:delivery outcome=${outcome} notificationId=${notification.notificationId} agentId=${notification.agentId}`,
            );
        };
        if (!(await queryPushSettings(ctx, recipient)).enabled) return unsent("disabled");
        const registrations = await queryLivePushRegistrations(ctx, recipient, Date.now());
        if (registrations.length === 0) return unsent("no_phones");
        const address = { instanceId: await this.#config.instanceId(), userId: recipient };
        for (const registration of registrations) {
            // A shutdown mid-send keeps the call for the next start, which carries on from here.
            ctx.lifetime?.throwIfAborted();
            // A phone is marked before its request, so a restart never sends it a second one,
            // even when the first request's fate is unknown.
            if ((await attempts.read(ctx, registration.id)) !== undefined) continue;
            // The list was read before the first request. A phone unpaired or removed since then
            // must not be sent to, however far along this notification already is.
            const live = await queryLivePushRegistrations(ctx, recipient, Date.now());
            if (
                !live.some(
                    (current) =>
                        current.id === registration.id && current.version === registration.version,
                )
            ) {
                continue;
            }
            await attempts.write(ctx, registration.id, true);
            await requireDurableCommit(ctx);
            const outcome = await pushRelaySend(
                pushRelayMessage(registration.token, address, notification),
                ctx.lifetime,
            );
            if (outcome.kind === "unregistered") {
                await deletePushRegistration(ctx, recipient, registration.id, registration.version);
            }
            ctx.log.info(
                `push:delivery outcome=${outcome.kind === "rejected" ? outcome.reason : outcome.kind} registrationId=${registration.id} notificationId=${notification.notificationId} agentId=${notification.agentId}`,
            );
        }
    }

    /** Forget what the agent's run asked to say, and tell the operator why. */
    async #drop(ctx: Context, scope: AgentModuleScope, outcome: string): Promise<void> {
        const pending = await scope.runKV.read(ctx, PENDING_KEY);
        if (pending === undefined) return;
        await scope.runKV.delete(ctx, PENDING_KEY);
        if (!Value.Check(pendingSchema, pending)) return;
        ctx.log.info(
            `push:notification outcome=${outcome} notificationId=${pending.notificationId} agentId=${scope.agent.id}`,
        );
    }

    /**
     * Whether a person can see and talk to this agent: a conversation they started themselves,
     * which has no parent, or a subtask. An agent another agent created to help it is hidden.
     */
    async #userVisible(ctx: Context, scope: AgentModuleScope): Promise<boolean> {
        if (this.#subtasks.isSubtask(scope.agent)) return true;
        return (await this.#requireAgents().parentOf(ctx, scope.agent.id)) === null;
    }

    /**
     * Who an agent works for. Standalone, the installation's one person. In team mode, the owner
     * of the task at the root of the agent's tree; a bot or a shared conversation there belongs
     * to no one person, so it has no recipient. An agent never names one.
     */
    async #recipient(ctx: Context, agentId: string): Promise<PushOwner | undefined> {
        if (!this.#team.enabled) return STANDALONE_PUSH_OWNER;
        const agents = this.#requireAgents();
        let root = agentId;
        for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
            const parent = await agents.parentOf(ctx, root);
            if (parent === null) return (await this.#tasks.forAgent(ctx, root))?.ownerUserId;
            root = parent;
        }
        return undefined;
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) throw new Error("Push has not started.");
        return this.#agents;
    }

    #owner(ctx: Context): PushOwner {
        if (!this.#team.enabled) return STANDALONE_PUSH_OWNER;
        const user = teamUser(ctx);
        if (user === undefined) throw new TeamAuthenticationError();
        return user.id;
    }
}

function checkRegistrationId(id: string): void {
    if (!Value.Check(pushRegistrationIdSchema, id)) {
        throw new PushError("invalid_request", "A registration ID must be a lowercase UUID.");
    }
}
