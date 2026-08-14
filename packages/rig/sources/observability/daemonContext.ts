import {
    createRootContext,
    traceSpan,
    withLogContext,
    withLogger,
    withTracer,
    type Context,
    type Logger,
    type RootContext,
    type TraceSpan,
    type Tracer as StdlibTracer,
} from "@steve.kite/stdlib";
import {
    ROOT_CONTEXT,
    SpanStatusCode,
    trace,
    type Attributes,
    type Span,
    type Tracer as OpenTelemetryTracer,
} from "@opentelemetry/api";

/** The application root is private so only semantic lifecycle factories can derive from it. */
let rootContext: RootContext = createRootContext();
let initialized = false;

export type ContextWork<Result> = (ctx: Context) => Result | PromiseLike<Result>;

/** Adds OpenTelemetry attributes to the stdlib span currently carried by a context. */
export function setSpanAttributes(ctx: Context, attributes: Attributes): void {
    const current = traceSpan.get(ctx);
    if (current instanceof OpenTelemetryTraceSpan) current.setAttributes(attributes);
}

/** Returns the OpenTelemetry trace ID for the span currently carried by a context. */
export function spanTraceId(ctx: Context): string | undefined {
    const current = traceSpan.get(ctx);
    if (!(current instanceof OpenTelemetryTraceSpan)) return undefined;
    const traceId = current.span.spanContext().traceId;
    return /^[0-9a-f]{32}$/u.test(traceId) && traceId !== "0".repeat(32) ? traceId : undefined;
}

export function withRequestContext<Result>(
    route: string,
    logContext: Readonly<Record<string, unknown>>,
    work: ContextWork<Result>,
): Promise<Awaited<Result>> {
    return runSemanticContext(`rig.api.${route}`, logContext, work);
}

/** Runs an intentionally untraced streaming request without creating a named lifetime context. */
export async function withUntracedRequestContext<Result>(
    route: string,
    logContext: Readonly<Record<string, unknown>>,
    work: ContextWork<Result>,
): Promise<Awaited<Result>> {
    if (!initialized) throw new Error("Daemon context has not been initialized");
    return await work(
        withLogContext(rootContext, {
            context: `rig.api.${route}`,
            ...logContext,
        }),
    );
}

export function withWorkerContext<Result>(
    worker: string,
    work: ContextWork<Result>,
    logContext: Readonly<Record<string, unknown>> = {},
): Promise<Awaited<Result>> {
    return runSemanticContext(`rig.worker.${worker}`, logContext, work);
}

export function withConnectionContext<Result>(
    connection: string,
    work: ContextWork<Result>,
    logContext: Readonly<Record<string, unknown>> = {},
): Promise<Awaited<Result>> {
    return runSemanticContext(`rig.connection.${connection}`, logContext, work);
}

/** Creates a daemon-owned context for a process whose lifetime outlives its startup call. */
export function createProcessContext(
    processName: string,
    logContext: Readonly<Record<string, unknown>> = {},
): Context {
    if (!initialized) throw new Error("Daemon context has not been initialized");
    const name = `rig.process.${processName}`;
    return withLogContext(rootContext.named(name), { context: name, ...logContext });
}

export function withProcessContext<Result>(
    processName: string,
    work: ContextWork<Result>,
    logContext: Readonly<Record<string, unknown>> = {},
): Promise<Awaited<Result>> {
    return runSemanticContext(`rig.process.${processName}`, logContext, work);
}

export function withTerminalContext<Result>(
    terminal: string,
    work: ContextWork<Result>,
    logContext: Readonly<Record<string, unknown>> = {},
): Promise<Awaited<Result>> {
    return runSemanticContext(`rig.terminal.${terminal}`, logContext, work);
}

async function runSemanticContext<Result>(
    name: string,
    logContext: Readonly<Record<string, unknown>>,
    work: ContextWork<Result>,
): Promise<Awaited<Result>> {
    if (!initialized) throw new Error("Daemon context has not been initialized");
    const named = withLogContext(rootContext.named(name), { context: name, ...logContext });
    return await named.span(name, work);
}

/** Installs logging and tracing on the private application root. */
export function initializeDaemonContext(
    logger: Logger,
    tracer: OpenTelemetryTracer = trace.getTracer("rig.daemon"),
): void {
    rootContext = withTracer(
        withLogger(createRootContext(), logger),
        new OpenTelemetryTracerAdapter(tracer),
    );
    initialized = true;
}

class OpenTelemetryTracerAdapter implements StdlibTracer {
    constructor(private readonly tracer: OpenTelemetryTracer) {}

    startSpan(name: string, parent: TraceSpan | undefined): TraceSpan {
        const parentContext =
            parent instanceof OpenTelemetryTraceSpan
                ? trace.setSpan(ROOT_CONTEXT, parent.span)
                : ROOT_CONTEXT;
        return new OpenTelemetryTraceSpan(this.tracer.startSpan(name, undefined, parentContext));
    }
}

class OpenTelemetryTraceSpan implements TraceSpan {
    #ended = false;
    #failed = false;

    constructor(readonly span: Span) {}

    setAttributes(attributes: Attributes): void {
        this.span.setAttributes(attributes);
    }

    recordException(error: unknown): void {
        this.#failed = true;
        this.span.recordException(error instanceof Error ? error : String(error));
        this.span.setStatus({ code: SpanStatusCode.ERROR });
    }

    end(): void {
        if (this.#ended) return;
        this.#ended = true;
        if (!this.#failed) this.span.setStatus({ code: SpanStatusCode.OK });
        this.span.end();
    }
}
