import { type Static, type TSchema, Type } from "@sinclair/typebox";

import { computePermissionsSchema } from "../ComputePermissions.js";

/**
 * The runner protocol: how a daemon drives computes on a machine dedicated to running them.
 *
 * Versions only grow. A daemon and a runner each support a contiguous range and use the highest
 * version both understand; every later version adds optional fields, methods, and events that an
 * older peer never sends and safely ignores. Version 1 carries filesystems and shells.
 */
export const RUNNER_PROTOCOL_VERSION = 1;
/** The oldest protocol version this package still speaks. */
export const MIN_RUNNER_PROTOCOL_VERSION = 1;

/**
 * The largest frame either side sends or accepts, header and body together.
 *
 * A file read or written through a runner moves in one frame, so this is also the largest file a
 * runner transfers in one call. The bound keeps one request from making either side hold an
 * arbitrarily large buffer.
 */
export const MAX_RUNNER_FRAME_BYTES = 64 * 1024 * 1024;
/** How many requests a runner works on at once for one daemon before refusing more. */
export const MAX_RUNNER_IN_FLIGHT_REQUESTS = 128;
/** How many computes one daemon may hold on a runner at once. */
export const MAX_RUNNER_COMPUTES = 512;
/** How many unacknowledged process-exit events a runner keeps for a daemon that is away. */
export const MAX_RUNNER_RETAINED_EVENTS = 1024;
/**
 * How many bytes of one stream channel may be sent but not yet consumed by the other side.
 *
 * This is both flow control and the retransmission budget: a sender keeps exactly these bytes
 * until they are acknowledged, so a dropped connection loses nothing and holds bounded memory.
 */
export const RUNNER_STREAM_WINDOW_BYTES = 512 * 1024;
/** The largest body one stream data frame carries. */
export const RUNNER_STREAM_CHUNK_BYTES = 64 * 1024;
/** How many processes, watches, and connections one daemon may hold open on a runner at once. */
export const MAX_RUNNER_STREAMS = 256;
/** How long a runner keeps a disconnected daemon's computes when the daemon does not say. */
export const DEFAULT_RUNNER_LEASE_GRACE_MS = 60_000;
/** The longest a daemon may ask a runner to keep its computes while it is away. */
export const MAX_RUNNER_LEASE_GRACE_MS = 10 * 60_000;

const exact = { additionalProperties: false } as const;
const requestId = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const sequence = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const protocolVersion = Type.Integer({ minimum: 1, maximum: 65_535 });
const text = (maxLength: number) => Type.String({ maxLength });
const path = Type.String({ minLength: 1, maxLength: 4096, pattern: "^[^\\u0000]+$" });
const sessionId = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const byteCount = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const optionalByteCount = Type.Optional(byteCount);

/** Daemon-chosen identity of one process, watch, or connection, unique within that daemon. */
export const runnerStreamIdSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

/**
 * One direction of a stream. `in` flows from the daemon to the runner: a process's stdin or bytes
 * sent on a connection. `out` and `err` flow back: stdout and stderr, bytes received on a
 * connection, or a watch's change batches as newline-delimited JSON.
 */
export const runnerStreamChannelSchema = Type.Union([
    Type.Literal("in"),
    Type.Literal("out"),
    Type.Literal("err"),
]);
export type RunnerStreamChannel = Static<typeof runnerStreamChannelSchema>;

/**
 * Where a compute's agent work runs in a container on the runner: the image, with the compute's
 * folder mounted at the same path. Git, terminals, and connections stay on the runner itself.
 */
export const runnerDockerSchema = Type.Object(
    { image: Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000-\\u0020]+$" }) },
    { additionalProperties: false },
);
export type RunnerDocker = Static<typeof runnerDockerSchema>;

/** A connection a runner listener accepted, numbered by the runner, until the daemon attaches it. */
export const runnerConnectionIdSchema = Type.Integer({
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
});

/** What a listener stream writes on `out` for every connection it accepts: one JSON line. */
export const runnerAcceptedConnectionSchema = Type.Object(
    { connection: runnerConnectionIdSchema },
    { additionalProperties: false },
);

/** One line on a watch stream's `out` channel. */
export const runnerWatchBatchSchema = Type.Object(
    {
        paths: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 4096 }),
        overflow: Type.Boolean(),
    },
    { additionalProperties: false },
);

/** Daemon-chosen identity of one compute on a runner, unique within that daemon. */
export const runnerComputeIdSchema = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z0-9_-]+$",
});

/** What a runner says about itself when it connects. */
export const runnerIdentitySchema = Type.Object(
    {
        /** The runner software's version, for display and diagnostics only. */
        version: Type.String({ minLength: 1, maxLength: 128 }),
        /** `process.platform` of the runner machine. */
        platform: Type.String({ minLength: 1, maxLength: 64 }),
        /** `process.arch` of the runner machine. */
        arch: Type.String({ minLength: 1, maxLength: 64 }),
        /** The machine's host name, for display only. */
        hostname: Type.String({ maxLength: 255 }),
        /** The runner user's home directory, where the daemon places folders that have no project. */
        home: path,
    },
    exact,
);
export type RunnerIdentity = Static<typeof runnerIdentitySchema>;

/**
 * The project files a runner protects on the daemon's behalf.
 *
 * Only names relative to a project root cross the protocol. The daemon's own private directories
 * are paths on the daemon's machine and mean nothing on the runner; the runner protects its own.
 */
export const runnerProjectPolicySchema = Type.Object(
    {
        protectedProjectFiles: Type.Optional(Type.Array(text(1024), { maxItems: 256 })),
        networkPolicyFiles: Type.Optional(Type.Array(text(1024), { maxItems: 256 })),
    },
    exact,
);
export type RunnerProjectPolicy = Static<typeof runnerProjectPolicySchema>;

/** A failure, as it crosses the protocol. Node-style codes survive so callers can branch on them. */
export const runnerErrorSchema = Type.Object(
    {
        name: Type.String({ maxLength: 256 }),
        message: Type.String({ maxLength: 16_384 }),
        code: Type.Optional(Type.String({ maxLength: 128 })),
        errno: Type.Optional(Type.Integer()),
        syscall: Type.Optional(Type.String({ maxLength: 128 })),
        path: Type.Optional(Type.String({ maxLength: 4096 })),
    },
    exact,
);
export type RunnerError = Static<typeof runnerErrorSchema>;

const fileStatSchema = Type.Object(
    {
        isFile: Type.Boolean(),
        isDirectory: Type.Boolean(),
        isSymbolicLink: Type.Boolean(),
        mode: Type.Optional(Type.Integer({ minimum: 0 })),
        size: Type.Number({ minimum: 0 }),
        mtimeMs: Type.Number(),
    },
    exact,
);

const runOptionsSchema = Type.Object(
    {
        command: Type.String({ maxLength: 1024 * 1024 }),
        permissions: computePermissionsSchema,
        cwd: Type.Optional(path),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
        maxOutputBytes: Type.Optional(byteCount),
        shell: Type.Optional(path),
        tty: Type.Optional(Type.Boolean()),
    },
    exact,
);

const runResultSchema = Type.Object(
    {
        stdout: Type.String(),
        stderr: Type.String(),
        stdoutBytes: optionalByteCount,
        stderrBytes: optionalByteCount,
        stdoutOmittedBytes: optionalByteCount,
        stderrOmittedBytes: optionalByteCount,
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
        timedOut: Type.Boolean(),
    },
    exact,
);

const sessionStatusSchema = Type.Union([
    Type.Literal("completed"),
    Type.Literal("killed"),
    Type.Literal("running"),
]);

const sessionSnapshotSchema = Type.Object(
    {
        command: Type.String(),
        cwd: Type.String(),
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
        sessionId,
        status: sessionStatusSchema,
        stderr: Type.String(),
        stderrDelta: Type.String(),
        stderrDeltaBytes: optionalByteCount,
        stderrDeltaOmittedBytes: optionalByteCount,
        stderrBytes: optionalByteCount,
        stderrOmittedBytes: optionalByteCount,
        stdout: Type.String(),
        stdoutDelta: Type.String(),
        stdoutDeltaBytes: optionalByteCount,
        stdoutDeltaOmittedBytes: optionalByteCount,
        stdoutBytes: optionalByteCount,
        stdoutOmittedBytes: optionalByteCount,
        timedOut: Type.Boolean(),
    },
    exact,
);

const sessionActivitySchema = Type.Object(
    {
        command: Type.String(),
        cwd: Type.String(),
        sessionId,
        status: Type.Literal("running"),
        usesSecrets: Type.Optional(Type.Boolean()),
    },
    exact,
);

const sessionExitSchema = Type.Object(
    {
        command: Type.String(),
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
        sessionId,
        status: Type.Union([Type.Literal("completed"), Type.Literal("killed")]),
    },
    exact,
);

const empty = Type.Object({}, exact);
const stream = runnerStreamIdSchema;
const signalSchema = Type.Union([
    Type.Literal("SIGHUP"),
    Type.Literal("SIGINT"),
    Type.Literal("SIGKILL"),
    Type.Literal("SIGQUIT"),
    Type.Literal("SIGTERM"),
]);
const terminalSize = {
    cols: Type.Integer({ minimum: 1, maximum: 10_000 }),
    rows: Type.Integer({ minimum: 1, maximum: 10_000 }),
};
const onCompute = <Properties extends Record<string, TSchema>>(properties: Properties) =>
    Type.Object({ computeId: runnerComputeIdSchema, ...properties }, exact);
const onPath = <Properties extends Record<string, TSchema>>(properties: Properties) =>
    onCompute({ permissions: computePermissionsSchema, path, ...properties });

/** How a frame body is read back into the value the caller passed. */
export const runnerBodyEncodingSchema = Type.Union([Type.Literal("text"), Type.Literal("bytes")]);
export type RunnerBodyEncoding = Static<typeof runnerBodyEncodingSchema>;

/**
 * Every request a daemon can make, with its parameters and its result.
 *
 * `body` marks the methods whose bytes travel as the frame body rather than inside the JSON
 * header: `request` for bytes the daemon sends, `response` for bytes the runner returns.
 */
export const runnerMethods = {
    "compute.create": {
        params: onCompute({
            cwd: path,
            policy: Type.Optional(runnerProjectPolicySchema),
            docker: Type.Optional(runnerDockerSchema),
        }),
        result: Type.Object(
            {
                cwd: path,
                home: Type.Optional(path),
                kind: Type.Union([
                    Type.Literal("host"),
                    Type.Literal("docker"),
                    Type.Literal("emulated"),
                ]),
                supportsSessionInput: Type.Boolean(),
                /** False when the runner had to build a new compute for a known ID. */
                retained: Type.Boolean(),
            },
            exact,
        ),
    },
    "compute.dispose": { params: onCompute({}), result: empty },
    "fs.chmod": { params: onPath({ mode: Type.Integer({ minimum: 0 }) }), result: empty },
    "fs.exists": { params: onPath({}), result: Type.Object({ exists: Type.Boolean() }, exact) },
    "fs.lstat": { params: onPath({}), result: Type.Object({ stat: fileStatSchema }, exact) },
    "fs.lstatMany": {
        params: onCompute({
            permissions: computePermissionsSchema,
            paths: Type.Array(path, { maxItems: 10_000 }),
        }),
        result: Type.Object(
            { stats: Type.Array(Type.Union([fileStatSchema, Type.Null()]), { maxItems: 10_000 }) },
            exact,
        ),
    },
    "fs.mkdir": {
        params: onPath({ recursive: Type.Optional(Type.Boolean()) }),
        result: empty,
    },
    "fs.move": {
        params: onCompute({
            permissions: computePermissionsSchema,
            source: path,
            destination: path,
        }),
        result: empty,
    },
    "fs.realpath": { params: onPath({}), result: Type.Object({ path }, exact) },
    "fs.readFile": { params: onPath({}), result: Type.Object({ text: Type.String() }, exact) },
    "fs.readFileBuffer": {
        params: onPath({
            maxBytes: Type.Optional(byteCount),
            noFollow: Type.Optional(Type.Boolean()),
        }),
        result: empty,
        body: "response",
    },
    "fs.readdir": {
        params: onPath({}),
        result: Type.Object({ entries: Type.Array(Type.String()) }, exact),
    },
    "fs.readdirPage": {
        params: onPath({
            after: Type.Optional(Type.String({ maxLength: 4096 })),
            limit: Type.Integer({ minimum: 1, maximum: 100_000 }),
        }),
        result: Type.Object(
            { entries: Type.Array(Type.String(), { maxItems: 100_000 }), hasMore: Type.Boolean() },
            exact,
        ),
    },
    "fs.rm": {
        params: onPath({
            recursive: Type.Optional(Type.Boolean()),
            force: Type.Optional(Type.Boolean()),
        }),
        result: empty,
    },
    "fs.setModificationTime": { params: onPath({ mtimeMs: Type.Number() }), result: empty },
    "fs.stat": { params: onPath({}), result: Type.Object({ stat: fileStatSchema }, exact) },
    "fs.writeFile": {
        params: onPath({ encoding: runnerBodyEncodingSchema }),
        result: empty,
        body: "request",
    },
    "shell.run": {
        params: onCompute({ options: runOptionsSchema }),
        result: Type.Object({ result: runResultSchema }, exact),
    },
    "shell.startSession": {
        params: onCompute({ options: runOptionsSchema }),
        result: Type.Object({ sessionId }, exact),
    },
    "shell.readSession": {
        params: onCompute({
            sessionId,
            peek: Type.Optional(Type.Boolean()),
            waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 24 * 60 * 60_000 })),
        }),
        result: Type.Object({ snapshot: Type.Union([sessionSnapshotSchema, Type.Null()]) }, exact),
    },
    "shell.killSession": {
        params: onCompute({ sessionId }),
        result: Type.Object({ snapshot: Type.Union([sessionSnapshotSchema, Type.Null()]) }, exact),
    },
    "shell.writeSession": {
        params: onCompute({
            permissions: computePermissionsSchema,
            sessionId,
            encoding: runnerBodyEncodingSchema,
        }),
        result: Type.Object({ written: Type.Boolean() }, exact),
        body: "request",
    },
    "shell.interruptSession": {
        params: onCompute({ sessionId }),
        result: Type.Object({ interrupted: Type.Union([Type.Boolean(), Type.Null()]) }, exact),
    },
    "shell.killAllSessions": {
        params: onCompute({}),
        result: Type.Object({ killed: Type.Integer({ minimum: 0 }) }, exact),
    },
    "shell.detachSession": { params: onCompute({ sessionId }), result: empty },
    "process.start": {
        params: onCompute({
            stream,
            command: Type.String({ minLength: 1, maxLength: 4096 }),
            args: Type.Array(Type.String({ maxLength: 1024 * 1024 }), { maxItems: 4096 }),
            cwd: Type.Optional(path),
            environment: Type.Optional(
                Type.Record(
                    Type.String({ minLength: 1, maxLength: 1024, pattern: "^[^=\\u0000]+$" }),
                    Type.Union([Type.String({ maxLength: 128 * 1024 }), Type.Null()]),
                ),
            ),
            terminal: Type.Optional(
                Type.Object(
                    { ...terminalSize, name: Type.Optional(Type.String({ maxLength: 128 })) },
                    exact,
                ),
            ),
        }),
        result: empty,
    },
    "process.resize": {
        params: Type.Object({ stream, ...terminalSize }, exact),
        result: empty,
    },
    "process.signal": {
        params: Type.Object({ stream, signal: signalSchema }, exact),
        result: empty,
    },
    "watch.start": {
        params: onCompute({
            stream,
            path,
            ignore: Type.Optional(Type.Array(Type.String({ maxLength: 255 }), { maxItems: 256 })),
        }),
        result: empty,
    },
    "net.connect": {
        params: onCompute({
            stream,
            host: Type.String({ minLength: 1, maxLength: 253 }),
            port: Type.Integer({ minimum: 1, maximum: 65_535 }),
        }),
        result: empty,
    },
    "net.listen": {
        params: onCompute({ stream }),
        result: Type.Object({ port: Type.Integer({ minimum: 1, maximum: 65_535 }) }, exact),
    },
    "net.accept": {
        params: onCompute({ stream, listener: stream, connection: runnerConnectionIdSchema }),
        result: empty,
    },
} as const satisfies Record<
    string,
    { params: TSchema; result: TSchema; body?: "request" | "response" }
>;

export type RunnerMethod = keyof typeof runnerMethods;
export type RunnerMethodParams<Method extends RunnerMethod> = Static<
    (typeof runnerMethods)[Method]["params"]
>;
export type RunnerMethodResult<Method extends RunnerMethod> = Static<
    (typeof runnerMethods)[Method]["result"]
>;

/**
 * Everything a runner reports without being asked.
 *
 * `shell.sessions` is state: the complete list of a compute's running commands, so a later one
 * replaces an earlier one and none needs to be kept for a daemon that is away. `shell.exit` is a
 * fact the daemon must not miss — it is how an agent learns that a background process ended — so
 * it carries a sequence number and is kept until the daemon acknowledges it.
 */
export const runnerEvents = {
    "shell.sessions": onCompute({
        sessions: Type.Array(sessionActivitySchema, { maxItems: 4096 }),
    }),
    "shell.exit": onCompute({ exit: sessionExitSchema }),
} as const satisfies Record<string, TSchema>;

export type RunnerEvent = keyof typeof runnerEvents;
export type RunnerEventParams<Event extends RunnerEvent> = Static<(typeof runnerEvents)[Event]>;

/** Every frame header either side can send. */
export const runnerFrameHeaderSchema = Type.Union([
    /** Runner → daemon, first frame: who is connecting and which versions it speaks. */
    Type.Object(
        {
            type: Type.Literal("hello"),
            protocol: Type.Object({ min: protocolVersion, max: protocolVersion }, exact),
            runner: runnerIdentitySchema,
        },
        exact,
    ),
    /** Daemon → runner: the version both will speak, and the daemon process the runner serves. */
    Type.Object(
        {
            type: Type.Literal("welcome"),
            protocol: protocolVersion,
            /** Changes every time the daemon process starts. */
            instanceId: Type.String({ minLength: 1, maxLength: 128 }),
            leaseGraceMs: Type.Integer({ minimum: 0, maximum: MAX_RUNNER_LEASE_GRACE_MS }),
        },
        exact,
    ),
    /** Runner → daemon: the handshake is complete; these computes survived since last time. */
    Type.Object(
        {
            type: Type.Literal("ready"),
            /**
             * Names the runner's record of this daemon process. It changes when the runner starts
             * over — after its own restart, or after it released the daemon's computes — and event
             * sequence numbers restart with it.
             */
            epoch: Type.String({ minLength: 1, maxLength: 128 }),
            computes: Type.Array(runnerComputeIdSchema, { maxItems: MAX_RUNNER_COMPUTES }),
            /** Streams the runner still holds for this daemon, including ended but unreleased ones. */
            streams: Type.Array(runnerStreamIdSchema, { maxItems: MAX_RUNNER_STREAMS }),
        },
        exact,
    ),
    Type.Object(
        {
            type: Type.Literal("request"),
            id: requestId,
            method: Type.String({ minLength: 1, maxLength: 128 }),
            params: Type.Unknown(),
        },
        exact,
    ),
    Type.Object(
        {
            type: Type.Literal("response"),
            id: requestId,
            result: Type.Optional(Type.Unknown()),
            error: Type.Optional(runnerErrorSchema),
        },
        exact,
    ),
    /** Daemon → runner: the caller stopped waiting; abort the work if it can be aborted. */
    Type.Object({ type: Type.Literal("cancel"), id: requestId }, exact),
    Type.Object(
        {
            type: Type.Literal("event"),
            /** Present on events kept until acknowledged. */
            seq: Type.Optional(sequence),
            event: Type.String({ minLength: 1, maxLength: 128 }),
            params: Type.Unknown(),
        },
        exact,
    ),
    /** Daemon → runner: every retained event up to and including `seq` was received. */
    Type.Object({ type: Type.Literal("ack"), seq: sequence }, exact),
    /**
     * Bytes on one stream channel, carried as the frame body. `offset` is the position of the first
     * body byte in the channel. After a reconnect a sender sends again everything not yet
     * acknowledged, and a receiver discards what it already has.
     */
    Type.Object(
        {
            type: Type.Literal("data"),
            stream,
            channel: runnerStreamChannelSchema,
            offset: byteCount,
        },
        exact,
    ),
    /** The receiver has consumed this many bytes of a channel in total, freeing that much window. */
    Type.Object(
        {
            type: Type.Literal("flow"),
            stream,
            channel: runnerStreamChannelSchema,
            consumed: byteCount,
        },
        exact,
    ),
    /** A channel ended after exactly `offset` bytes. */
    Type.Object(
        {
            type: Type.Literal("eof"),
            stream,
            channel: runnerStreamChannelSchema,
            offset: byteCount,
        },
        exact,
    ),
    /** Runner → daemon: the stream ended, after every output channel's eof. */
    Type.Object(
        {
            type: Type.Literal("exit"),
            stream,
            exitCode: Type.Union([Type.Integer(), Type.Null()]),
            signal: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
            error: Type.Optional(runnerErrorSchema),
        },
        exact,
    ),
    /** Daemon → runner: stop this stream now — kill the process, drop the connection, end the watch. */
    Type.Object({ type: Type.Literal("close"), stream }, exact),
    /** Daemon → runner: the daemon has the stream's exit, or never wants it; forget the stream. */
    Type.Object({ type: Type.Literal("release"), stream }, exact),
    Type.Object({ type: Type.Literal("ping"), nonce: requestId }, exact),
    Type.Object({ type: Type.Literal("pong"), nonce: requestId }, exact),
    /**
     * Either side: this connection is ending on purpose. From a daemon it also releases everything
     * the runner holds for it, immediately rather than after the lease grace.
     */
    Type.Object({ type: Type.Literal("goodbye"), reason: Type.String({ maxLength: 1024 }) }, exact),
]);
export type RunnerFrameHeader = Static<typeof runnerFrameHeaderSchema>;
