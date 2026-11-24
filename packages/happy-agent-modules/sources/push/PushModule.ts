import type { AgentKV, AgentModule } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { ConfigModule } from "../config/index.js";
import { DurableFunctionsModule } from "../durableFunctions/index.js";
import { requireDurableCommit } from "../impl/durableCommit.js";
import { TeamAuthenticationError, TeamModule, teamUser } from "../team/index.js";

import { pushRelayMessage } from "./impl/pushRelayMessage.js";
import { pushRelaySend } from "./impl/pushRelaySend.js";
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

const DELIVER_FUNCTION = "push.deliver";

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
 */
export class PushModule implements AgentModule {
    readonly name = "push";
    readonly migrations = pushMigrations;

    readonly #team: TeamModule;
    readonly #config: ConfigModule;
    readonly #durableFunctions: DurableFunctionsModule;

    constructor(team: TeamModule, config: ConfigModule, durableFunctions: DurableFunctionsModule) {
        this.#team = team;
        this.#config = config;
        this.#durableFunctions = durableFunctions;
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

    /**
     * Register the caller's phone under `id`, or renew it for another 30 days under a new
     * version. `request` is what the phone sent, unchecked.
     */
    async register(ctx: Context, id: string, request: unknown): Promise<PushRegistration> {
        const owner = this.#owner(ctx);
        checkRegistrationId(id);
        const input = parsePushRegistrationInput(request);
        if (input === undefined) {
            throw new PushError("invalid_request", "The push registration is invalid.");
        }
        return await savePushRegistration(ctx, owner, id, input, Date.now());
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
     * Notifications to one person are delivered in the order they were sent.
     */
    async send(ctx: Context, recipient: PushOwner, notification: PushNotification): Promise<void> {
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
        if (!(await queryPushSettings(ctx, recipient)).enabled) return;
        const registrations = await queryLivePushRegistrations(ctx, recipient, Date.now());
        if (registrations.length === 0) return;
        const address = { instanceId: await this.#config.instanceId(), userId: recipient };
        for (const registration of registrations) {
            // A shutdown mid-send keeps the call for the next start, which carries on from here.
            ctx.lifetime?.throwIfAborted();
            // A phone is marked before its request, so a restart never sends it a second one,
            // even when the first request's fate is unknown.
            if ((await attempts.read(ctx, registration.id)) !== undefined) continue;
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
