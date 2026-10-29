import { Type, type Static } from "@sinclair/typebox";

/**
 * Strict UUIDv7 identifier for events. UUIDv7 values are time-ordered and
 * lexicographically sortable. The pattern enforces version 7 and variant bits.
 */
export const eventIdSchema = Type.String({
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});

/** Maximum length for an event type identifier. */
export const MAX_EVENT_TYPE_LENGTH = 128;

/**
 * Event type identifier. Lowercase, dot-separated segments, each starting with a letter, so an
 * empty segment or a trailing dot is rejected rather than stored as a type nothing can match.
 * Examples: "agent.created", "message.accepted", "tool.started".
 */
export const eventTypeSchema = Type.String({
    minLength: 1,
    maxLength: MAX_EVENT_TYPE_LENGTH,
    pattern: "^[a-z][a-z0-9_-]*(\\.[a-z][a-z0-9_-]*)*$",
});

/** Maximum length for an agent identifier carried on an event. */
export const MAX_EVENT_AGENT_ID_LENGTH = 128;

/** Agent identifier carried on events that are scoped to a single agent. */
export const eventAgentIdSchema = Type.String({
    minLength: 1,
    maxLength: MAX_EVENT_AGENT_ID_LENGTH,
});

/**
 * Raw event envelope. The payload is stored as-is after a structured clone.
 * Every event receives a monotonic UUIDv7 id at the moment it is recorded.
 */
export const eventSchema = Type.Object(
    {
        agentId: Type.Optional(eventAgentIdSchema),
        id: eventIdSchema,
        occurredAt: Type.Integer({ minimum: 0 }),
        payload: Type.Unknown(),
        type: eventTypeSchema,
    },
    { additionalProperties: false },
);

export type AgentEvent = Static<typeof eventSchema>;

/** The exact newest durable event identity and time for one agent resource. */
export const latestAgentEventSchema = Type.Object(
    {
        cursor: eventIdSchema,
        occurredAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);

export type LatestAgentEvent = Static<typeof latestAgentEventSchema>;

/** Input for appending a raw event. The module assigns id and occurredAt. */
export const appendEventInputSchema = Type.Object(
    {
        agentId: Type.Optional(eventAgentIdSchema),
        payload: Type.Unknown(),
        type: eventTypeSchema,
    },
    { additionalProperties: false },
);

export type AppendEventInput = Static<typeof appendEventInputSchema>;

/** Result of a replay query over the in-memory queue. */
export const eventReplaySchema = Type.Object(
    {
        cursor: eventIdSchema,
        events: Type.Array(eventSchema),
        latestCursor: eventIdSchema,
    },
    { additionalProperties: false },
);

export type EventReplay = Static<typeof eventReplaySchema>;

/** Listener invoked for each newly recorded event after it is visible. */
export const eventListenerSchema = Type.Function([eventSchema], Type.Void());

export type EventListener = Static<typeof eventListenerSchema>;

/** Opaque context carrier for listener callbacks. */
export const eventContextSchema = Type.Unsafe<import("@steve.kite/stdlib").Context>(
    Type.Object({}, { additionalProperties: true }),
);

const eventVoidOrPromiseVoid = Type.Union([Type.Void(), Type.Promise(Type.Void())]);

/**
 * Listener contract for hosts that want to observe events.
 * onEventTransactional runs inside the committing transaction.
 * onEvent runs after the transaction commits.
 */
export const eventsModuleListenerSchema = Type.Object(
    {
        onEventTransactional: Type.Optional(
            Type.Function([eventContextSchema, eventSchema], eventVoidOrPromiseVoid),
        ),
        onEvent: Type.Optional(
            Type.Function([eventContextSchema, eventSchema], eventVoidOrPromiseVoid),
        ),
    },
    { additionalProperties: false },
);

export type EventsModuleListener = Static<typeof eventsModuleListenerSchema>;

/** Known lifecycle event types emitted by the module through AgentModule hooks. */
export const EVENT_TYPE = {
    AGENT_CREATED: "agent.created",
    AGENT_RESTORED: "agent.restored",
    AGENT_ARCHIVED: "agent.archived",
    AGENT_ERASED: "agent.erased",
    MESSAGE_ACCEPTED: "message.accepted",
    PERMISSION_CHANGED: "agent.permission-changed",
    METADATA_CHANGED: "agent.metadata-changed",
    LOOP_STARTED: "loop.started",
    PROVIDER_EVENT: "provider.event",
    TOOL_STARTED: "tool.started",
    TOOL_COMPLETED: "tool.completed",
    INFERENCE_COMPLETED: "inference.completed",
    TURN_COMPLETED: "turn.completed",
    LOOP_SETTLED: "loop.settled",
} as const;

export type EventType = (typeof EVENT_TYPE)[keyof typeof EVENT_TYPE];
