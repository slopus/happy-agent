import type { HappyAgentEvent } from "./protocol/events.js";

const RETENTION_MS = 60_000;
const MAX_EVENTS = 10_000;

interface RecentEvent {
    readonly event: HappyAgentEvent;
    readonly receivedAt: number;
    readonly sequence: number;
}

/** A bounded race window used to rebase snapshots loaded after the SSE stream opened. */
export class HappyReducerRecentEvents {
    #events: RecentEvent[] = [];
    #epoch = 0;
    #nextSequence = 0;

    get epoch(): number {
        return this.#epoch;
    }

    checkpoint(): number {
        return this.#nextSequence;
    }

    remember(event: HappyAgentEvent, now: number): void {
        this.#prune(now);
        this.#events.push({ event, receivedAt: now, sequence: this.#nextSequence });
        this.#nextSequence += 1;
        if (this.#events.length <= MAX_EVENTS) return;
        this.#events.splice(0, this.#events.length - MAX_EVENTS);
        this.#epoch += 1;
    }

    since(checkpoint: number, now: number): HappyAgentEvent[] {
        this.#prune(now);
        return this.#events
            .filter(({ sequence }) => sequence >= checkpoint)
            .map(({ event }) => event);
    }

    isCompleteSince(epoch: number, startedAt: number, now: number): boolean {
        this.#prune(now);
        return this.#epoch === epoch && now - startedAt <= RETENTION_MS;
    }

    invalidate(): void {
        this.#events = [];
        this.#epoch += 1;
    }

    #prune(now: number): void {
        const firstRetained = this.#events.findIndex(
            ({ receivedAt }) => now - receivedAt <= RETENTION_MS,
        );
        if (firstRetained === 0 || this.#events.length === 0) return;
        if (firstRetained < 0) this.#events = [];
        else this.#events.splice(0, firstRetained);
        this.#epoch += 1;
    }
}
