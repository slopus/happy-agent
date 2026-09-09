import type { TraceSpan, Tracer } from "@steve.kite/stdlib";

export interface RecordedSpan extends TraceSpan {
    readonly name: string;
    readonly parent: TraceSpan | undefined;
    readonly errors: unknown[];
    ends: number;
}

/** Inspect span nesting and completion without running an exporter or opening a port. */
export function recordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
    const spans: RecordedSpan[] = [];
    return {
        spans,
        tracer: {
            startSpan(name, parent) {
                const span: RecordedSpan = {
                    name,
                    parent,
                    errors: [],
                    ends: 0,
                    end() {
                        this.ends += 1;
                    },
                    recordException(error) {
                        this.errors.push(error);
                    },
                };
                spans.push(span);
                return span;
            },
        },
    };
}
