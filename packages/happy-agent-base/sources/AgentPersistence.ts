import type {
    SessionAssistantBlock,
    SessionMessage,
    SessionSystemMessage,
    SessionToolResultMessage,
} from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { AgentDatabase } from "./AgentDatabase.js";
import type { AgentMessageMetadata } from "./AgentMetadata.js";
import type { AgentQueuedMessage } from "./AgentQueuedMessage.js";

/**
 * One record of the main context store. Only content that is part of the model context lives
 * here: queued messages enter when a turn consumes them, assistant output is appended one finished
 * block at a time, and tool results follow the blocks that called them, so records always arrive
 * in context order and consecutive block records reassemble into one assistant message. A
 * compaction record carries the complete replacement context — the messages that stay — and is
 * written in the same transaction that physically deletes the superseded records, so it opens
 * the store; the records after it append as usual.
 */
export type AgentRecord =
    /**
     * A message a turn consumed from one of the delivery queues. It is identified and
     * deduplicated whatever role it carries, so this is also where a queued system notice or an
     * agent-to-agent payload lands.
     */
    | {
          readonly type: "user";
          readonly id: string;
          readonly message: AgentQueuedMessage;
          readonly metadata?: AgentMessageMetadata;
      }
    | {
          readonly type: "block";
          /** Base CUID2 when `block` is a provider-native tool call or result. */
          readonly id?: string;
          readonly block: SessionAssistantBlock;
      }
    | {
          readonly type: "tool";
          /** Base CUID2 paired with the provider-native `message.callId`. */
          readonly id: string;
          readonly message: SessionToolResultMessage;
      }
    | { readonly type: "system"; readonly message: SessionSystemMessage }
    | {
          readonly type: "compaction";
          /** Base-to-provider tool identities required to replay `messages`. */
          readonly contextToolIds: readonly (readonly [id: string, callId: string])[];
          readonly messages: readonly SessionMessage[];
      };

/**
 * Storage for one agent: an append-only main context store plus a sorted key-value store held
 * alongside it. A sent message is first written under a `pending.` key ordered by append time;
 * it reaches the main store only when a turn consumes it into the context, and its pending key
 * is deleted at that moment. A `message.` uniqueness key makes retrying a cuid2 message ID an
 * ignored database conflict; history replacement removes keys for the records it deletes.
 * Exactly one owner connects to a store. Transactions, uniqueness constraints, and ordered keys
 * keep history order aligned with storage order. Key-value operations — a module's or a tool's —
 * run as they come, so each one has to be atomic on its own, but no implementation ever has to
 * defend against a second owner.
 */
export interface AgentPersistence {
    /** The root Drizzle facade for this store. */
    readonly database: AgentDatabase;
    /**
     * Run work atomically. The implementation opens a transaction and passes work a derived
     * context that its own operations recognize and that carries stdlib's universal
     * `afterCommit` scope. Work resolving commits every operation and then drains that scope; a
     * thrown error rolls everything back without draining it.
     */
    transaction<Result>(ctx: Context, work: (ctx: Context) => Promise<Result>): Promise<Result>;
    /** Every record in the main context store, in append order. */
    load(ctx: Context): Promise<readonly AgentRecord[]>;
    /** Add one more record to the end of the main context store. */
    append(ctx: Context, record: AgentRecord): Promise<void>;
    /**
     * Physically delete every record in the main context store. Called only inside the
     * compaction transaction, immediately before the replacement compaction record is appended,
     * so the deletion and the replacement commit atomically.
     */
    clearRecords(ctx: Context): Promise<void>;
    /** Every stored entry whose key starts with the prefix, sorted by key. */
    readValues(
        ctx: Context,
        prefix: string,
    ): Promise<readonly { readonly key: string; readonly value: unknown }[]>;
    /** Store the value under `key`, replacing whatever was there before. */
    writeValue(ctx: Context, key: string, value: unknown): Promise<void>;
    /**
     * Store the value only when `key` is absent. Returns false for the database uniqueness
     * conflict without changing the existing value.
     */
    writeValueIfAbsent(ctx: Context, key: string, value: unknown): Promise<boolean>;
    /** Remove the entry stored under `key`, if any. */
    deleteValue(ctx: Context, key: string): Promise<void>;
}
