import {
    eventIdsShareScope,
    type EventId,
    type SessionPermissionReview,
    type SessionEvent,
    type ShellCommandState,
} from "../index.js";
import { isLiveOnlySessionEvent } from "./isLiveOnlySessionEvent.js";
import type { ProviderQuota } from "@slopus/happy-providers";
import { affectsSessionUsage } from "../usage/affectsSessionUsage.js";
import { asyncLock, type AsyncLock } from "../../concurrency/index.js";
import type { Context } from "@steve.kite/stdlib";

export type SessionEventListener = (event: SessionEvent) => void | Promise<void>;
export type SessionEventAppendHook = (ctx: Context, event: SessionEvent) => void | Promise<void>;
export type SessionEventNotification = () => void | Promise<void>;
export type SessionEventNotificationScheduler = (
    ctx: Context,
    notify: SessionEventNotification,
) => void | Promise<void>;
export interface SessionEventLogCheckpoint {
    readonly eventIndexes: ReadonlyMap<EventId, number>;
    readonly eventStartIndex: number;
    readonly events: readonly SessionEvent[];
    readonly firstEventId: EventId | undefined;
    readonly lastEventId: EventId | undefined;
    readonly messageCreatedAt: ReadonlyMap<string, number>;
    readonly messageEventId: ReadonlyMap<string, EventId>;
    readonly messageSteeredAt: ReadonlyMap<string, number>;
    readonly messageSteeringEventId: ReadonlyMap<string, EventId>;
    readonly messageSubmissions: ReadonlyMap<string, SessionEvent & { type: "message_submitted" }>;
    readonly nextEventIndex: number;
    readonly permissionReviewEventIds: ReadonlyMap<string, EventId>;
    readonly permissionReviews: ReadonlyMap<string, SessionPermissionReview>;
    readonly providerQuotas: ReadonlyMap<string, ProviderQuota>;
    readonly revision: number;
    readonly shellCommands: ReadonlyMap<string, ShellCommandState>;
    readonly usageRevision: number;
}
const SESSION_EVENT_RETENTION_LIMIT = 4_096;

export class SessionEventLog {
    readonly #appendLock: AsyncLock = asyncLock({ reentry: "block" });
    #events: SessionEvent[] = [];
    #eventIndexes = new Map<EventId, number>();
    #eventStartIndex = 0;
    #nextEventIndex = 0;
    #firstEventId: EventId | undefined;
    #lastEventId: EventId | undefined;
    #listeners = new Set<SessionEventListener>();
    #messageCreatedAt = new Map<string, number>();
    #messageEventId = new Map<string, EventId>();
    #messageSteeredAt = new Map<string, number>();
    #messageSteeringEventId = new Map<string, EventId>();
    #permissionReviews = new Map<string, SessionPermissionReview>();
    #permissionReviewEventIds = new Map<string, EventId>();
    #messageSubmissions = new Map<string, SessionEvent & { type: "message_submitted" }>();
    #providerQuotas = new Map<string, ProviderQuota>();
    #shellCommands = new Map<string, ShellCommandState>();
    #deferNotification: SessionEventNotificationScheduler | undefined;
    #onAppend: SessionEventAppendHook | undefined;
    #retentionLimit: number;
    #revision = 0;
    #usageRevision = 0;

    constructor(
        options: {
            deferNotification?: SessionEventNotificationScheduler;
            events?: readonly SessionEvent[];
            lastEventId?: EventId;
            onAppend?: SessionEventAppendHook;
            retentionLimit?: number;
        } = {},
    ) {
        this.#deferNotification = options.deferNotification;
        this.#retentionLimit = options.retentionLimit ?? SESSION_EVENT_RETENTION_LIMIT;
        this.#events = [...(options.events ?? [])]
            .filter((event) => !isLiveOnlySessionEvent(event))
            .slice(-this.#retentionLimit);
        for (const [index, event] of this.#events.entries()) {
            this.#eventIndexes.set(event.id, index);
            if (event.type === "message_submitted") {
                this.#messageSubmissions.set(event.data.message.id, event);
            }
            this.#recordMessageTime(event);
            this.#recordPermissionReview(event);
            this.#recordCurrentState(event);
        }
        this.#nextEventIndex = this.#events.length;
        this.#firstEventId = this.#events.at(0)?.id;
        this.#lastEventId = options.lastEventId ?? this.#events.at(-1)?.id;
        this.#onAppend = options.onAppend;
    }

    async append(ctx: Context, event: SessionEvent): Promise<SessionEvent> {
        return await this.#append(ctx, event, true);
    }

    /**
     * Add an event whose durable row was written by the caller's transaction already.
     *
     * Agent Base's transaction hooks need to write the session event and message rows before the
     * outer transaction commits, while the in-memory event log must not move ahead of a rollback.
     * This path performs only the in-memory append and subscriber delivery after that commit.
     */
    async appendProjected(ctx: Context, event: SessionEvent): Promise<SessionEvent> {
        return await this.#append(ctx, event, false);
    }

    async #append(ctx: Context, event: SessionEvent, persist: boolean): Promise<SessionEvent> {
        const notify = await this.#appendLock.runInLock(ctx, async (lockedCtx) => {
            // The durable hook runs before any in-memory projection changes. A rejected
            // persistence write therefore leaves the log, cursors, and notifications untouched.
            if (persist && this.#onAppend !== undefined) await this.#onAppend(lockedCtx, event);
            if (!isLiveOnlySessionEvent(event)) {
                this.#eventIndexes.set(event.id, this.#nextEventIndex);
                this.#nextEventIndex += 1;
                this.#events.push(event);
                this.#firstEventId ??= event.id;
                if (event.type === "message_submitted") {
                    this.#messageSubmissions.set(event.data.message.id, event);
                }
                this.#recordMessageTime(event);
                this.#recordPermissionReview(event);
                this.#recordCurrentState(event);
                if (this.#events.length > this.#retentionLimit) {
                    const removed = this.#events.shift();
                    if (removed !== undefined) {
                        this.#eventIndexes.delete(removed.id);
                        this.#forgetEventIndexes(removed);
                    }
                    this.#eventStartIndex += 1;
                    this.#firstEventId = this.#events[0]?.id;
                }
            }

            this.#revision += 1;
            if (affectsSessionUsage(event)) this.#usageRevision += 1;
            this.#lastEventId = event.id;
            const listeners = [...this.#listeners];
            return (): void | Promise<void> => {
                let pending: Promise<void> | undefined;
                for (const listener of listeners) {
                    if (pending !== undefined) {
                        pending = pending.then(async () => {
                            try {
                                await listener(event);
                            } catch {
                                // Subscribers are optional observers. A disconnected or broken
                                // consumer must not roll back an event that is already durable.
                            }
                        });
                        continue;
                    }
                    try {
                        const result = listener(event);
                        if (result !== undefined) {
                            pending = Promise.resolve(result).catch(() => {
                                // Subscribers are optional observers. A disconnected or broken
                                // consumer must not roll back an event that is already durable.
                            });
                        }
                    } catch {
                        // Subscribers are optional observers. A disconnected or broken
                        // consumer must not roll back an event that is already durable.
                    }
                }
                return pending;
            };
        });

        // Subscribers are external observers. Invoke them only after the durable event and
        // in-memory projection have released the state lock. Do not serialize observer completion:
        // a listener may append and await another event on this same log.
        const deliver = async () => {
            await notify();
        };
        if (this.#deferNotification === undefined) {
            await deliver();
        } else {
            const scheduled = this.#deferNotification(ctx, deliver);
            if (scheduled !== undefined) await scheduled;
        }
        return event;
    }

    /**
     * Delivers a transient event to attached session streams without entering the durable append
     * lock. Completed transcript messages supersede these live inference updates.
     */
    publishTransient(event: SessionEvent): void {
        for (const listener of this.#listeners) {
            try {
                const pending = listener(event);
                if (pending !== undefined) void Promise.resolve(pending).catch(() => undefined);
            } catch {
                // A disconnected observer must not interrupt the provider stream.
            }
        }
    }

    checkpoint(): SessionEventLogCheckpoint {
        return {
            eventIndexes: new Map(this.#eventIndexes),
            eventStartIndex: this.#eventStartIndex,
            events: [...this.#events],
            firstEventId: this.#firstEventId,
            lastEventId: this.#lastEventId,
            messageCreatedAt: new Map(this.#messageCreatedAt),
            messageEventId: new Map(this.#messageEventId),
            messageSteeredAt: new Map(this.#messageSteeredAt),
            messageSteeringEventId: new Map(this.#messageSteeringEventId),
            messageSubmissions: new Map(this.#messageSubmissions),
            nextEventIndex: this.#nextEventIndex,
            permissionReviewEventIds: new Map(this.#permissionReviewEventIds),
            permissionReviews: new Map(this.#permissionReviews),
            providerQuotas: new Map(this.#providerQuotas),
            revision: this.#revision,
            shellCommands: new Map(this.#shellCommands),
            usageRevision: this.#usageRevision,
        };
    }

    restore(checkpoint: SessionEventLogCheckpoint): void {
        this.#eventIndexes = new Map(checkpoint.eventIndexes);
        this.#eventStartIndex = checkpoint.eventStartIndex;
        this.#events = [...checkpoint.events];
        this.#firstEventId = checkpoint.firstEventId;
        this.#lastEventId = checkpoint.lastEventId;
        this.#messageCreatedAt = new Map(checkpoint.messageCreatedAt);
        this.#messageEventId = new Map(checkpoint.messageEventId);
        this.#messageSteeredAt = new Map(checkpoint.messageSteeredAt);
        this.#messageSteeringEventId = new Map(checkpoint.messageSteeringEventId);
        this.#messageSubmissions = new Map(checkpoint.messageSubmissions);
        this.#nextEventIndex = checkpoint.nextEventIndex;
        this.#permissionReviewEventIds = new Map(checkpoint.permissionReviewEventIds);
        this.#permissionReviews = new Map(checkpoint.permissionReviews);
        this.#providerQuotas = new Map(checkpoint.providerQuotas);
        this.#revision = checkpoint.revision;
        this.#shellCommands = new Map(checkpoint.shellCommands);
        this.#usageRevision = checkpoint.usageRevision;
    }

    firstCreatedAt(): number | undefined {
        return this.#events.at(0)?.createdAt;
    }

    firstMessageCreatedAt(): number | undefined {
        return this.#events.find((event) => event.type === "message_submitted")?.createdAt;
    }

    lastEventId(): EventId | undefined {
        return this.#lastEventId;
    }

    lastCreatedAt(): number | undefined {
        return this.#events.at(-1)?.createdAt;
    }

    messageSubmission(
        messageId: string,
    ): (SessionEvent & { type: "message_submitted" }) | undefined {
        return this.#messageSubmissions.get(messageId);
    }

    messageCreatedAt(messageId: string): number | undefined {
        return this.#messageCreatedAt.get(messageId);
    }

    messageEventId(messageId: string): EventId | undefined {
        return this.#messageEventId.get(messageId);
    }

    messageSteeredAt(messageId: string): number | undefined {
        return this.#messageSteeredAt.get(messageId);
    }

    permissionReviews(toolCallIds: ReadonlySet<string>): SessionPermissionReview[] {
        return [...toolCallIds].flatMap((toolCallId) => {
            const review = this.#permissionReviews.get(toolCallId);
            return review === undefined ? [] : [review];
        });
    }

    /**
     * Read-only live view for synchronous in-process reducers.
     *
     * `since(undefined)` intentionally returns a defensive copy for protocol
     * callers. Server-owned reducers already cannot mutate this type and may
     * process very long logs, so copying the complete array first is pure cost.
     */
    all(): readonly SessionEvent[] {
        return this.#events;
    }

    latestProviderQuotas(): ReadonlyMap<string, ProviderQuota> {
        return this.#providerQuotas;
    }

    revision(): number {
        return this.#revision;
    }

    usageRevision(): number {
        return this.#usageRevision;
    }

    shellCommandStates(): readonly ShellCommandState[] {
        return [...this.#shellCommands.values()];
    }

    since(eventId: EventId | undefined): readonly SessionEvent[] | undefined {
        if (eventId === undefined || eventId.length === 0) {
            return [...this.#events];
        }

        const index = this.#eventIndexes.get(eventId);
        if (index !== undefined) {
            return this.#events.slice(index - this.#eventStartIndex + 1);
        }

        if (
            this.#firstEventId === undefined ||
            this.#lastEventId === undefined ||
            eventId < this.#firstEventId ||
            eventId > this.#lastEventId ||
            !eventIdsShareScope(eventId, this.#lastEventId)
        ) {
            return undefined;
        }
        let low = 0;
        let high = this.#events.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if ((this.#events[middle]?.id ?? eventId) <= eventId) low = middle + 1;
            else high = middle;
        }
        return this.#events.slice(low);
    }

    subscribe(listener: SessionEventListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    #recordMessageTime(event: SessionEvent): void {
        if (event.type === "steering_applied") {
            for (const messageId of event.data.messageIds) {
                this.#messageSteeredAt.set(messageId, event.createdAt);
                this.#messageSteeringEventId.set(messageId, event.id);
            }
            return;
        }
        if (
            event.type === "message_submitted" ||
            event.type === "agent_message" ||
            event.type === "system_notice"
        ) {
            if (!this.#messageCreatedAt.has(event.data.message.id)) {
                this.#messageCreatedAt.set(event.data.message.id, event.createdAt);
                this.#messageEventId.set(event.data.message.id, event.id);
            }
        }
    }

    #recordPermissionReview(event: SessionEvent): void {
        if (event.type === "session_reset") {
            this.#permissionReviews.clear();
            this.#permissionReviewEventIds.clear();
            return;
        }
        if (event.type !== "agent_event") return;
        if (event.data.event.type === "temporary_full_access_started") {
            const review = event.data.event;
            this.#permissionReviews.set(review.toolCallId, {
                action: review.action,
                decision: "allow",
                fullAccessGranted: true,
                reason: review.reason,
                risk: review.risk,
                toolCallId: review.toolCallId,
                userAuthorization: review.userAuthorization,
            });
            this.#permissionReviewEventIds.set(review.toolCallId, event.id);
            return;
        }
        if (event.data.event.type !== "permission_review") return;
        const review = event.data.event;
        this.#permissionReviews.set(review.toolCallId, {
            action: review.action,
            decision: review.decision,
            reason: review.reason,
            risk: review.risk,
            toolCallId: review.toolCallId,
            userAuthorization: review.userAuthorization,
        });
        this.#permissionReviewEventIds.set(review.toolCallId, event.id);
    }

    #forgetEventIndexes(event: SessionEvent): void {
        if (
            event.type === "message_submitted" ||
            event.type === "agent_message" ||
            event.type === "system_notice"
        ) {
            const messageId = event.data.message.id;
            if (
                event.type === "message_submitted" &&
                this.#messageSubmissions.get(messageId)?.id === event.id
            ) {
                this.#messageSubmissions.delete(messageId);
            }
            if (this.#messageEventId.get(messageId) === event.id) {
                this.#messageCreatedAt.delete(messageId);
                this.#messageEventId.delete(messageId);
            }
        }
        if (event.type === "steering_applied") {
            for (const messageId of event.data.messageIds) {
                if (this.#messageSteeringEventId.get(messageId) !== event.id) continue;
                this.#messageSteeredAt.delete(messageId);
                this.#messageSteeringEventId.delete(messageId);
            }
        }
        if (
            event.type === "agent_event" &&
            (event.data.event.type === "permission_review" ||
                event.data.event.type === "temporary_full_access_started")
        ) {
            const toolCallId = event.data.event.toolCallId;
            if (this.#permissionReviewEventIds.get(toolCallId) === event.id) {
                this.#permissionReviews.delete(toolCallId);
                this.#permissionReviewEventIds.delete(toolCallId);
            }
        }
    }

    #recordCurrentState(event: SessionEvent): void {
        if (event.type === "provider_quota_observed") {
            const known = this.#providerQuotas.get(event.data.providerId);
            if (known === undefined || event.data.quota.capturedAt >= known.capturedAt) {
                this.#providerQuotas.set(event.data.providerId, event.data.quota);
            }
            return;
        }
        if (event.type === "shell_command_started") {
            this.#shellCommands.set(event.data.commandId, {
                ...event.data,
                status: "running",
            });
        } else if (event.type === "shell_command_finished") {
            this.#shellCommands.set(event.data.commandId, {
                ...event.data,
                status: "finished",
            });
        } else {
            return;
        }
        while (this.#shellCommands.size > 100) {
            const oldest = this.#shellCommands.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.#shellCommands.delete(oldest);
        }
    }
}
