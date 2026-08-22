import type { TSchema } from "@sinclair/typebox";
import { Value, ValueErrorType, type ValueError } from "@sinclair/typebox/value";

const MAX_REPORTED_ARGUMENT_ISSUES = 8;

interface ArgumentIssue {
    readonly type: ValueErrorType;
    readonly path: string;
    readonly value: unknown;
    readonly message: string;
}

function normalizedIssues(issues: readonly ArgumentIssue[]): ArgumentIssue[] {
    const requiredPaths = new Set(
        issues
            .filter(({ type }) => type === ValueErrorType.ObjectRequiredProperty)
            .map(({ path }) => path),
    );
    const seen = new Set<string>();
    const normalized: ArgumentIssue[] = [];
    for (const issue of issues) {
        // TypeBox reports a missing property twice: once as missing and once because `undefined`
        // is not the property's declared type. The first error is the useful one.
        if (
            issue.type !== ValueErrorType.ObjectRequiredProperty &&
            issue.value === undefined &&
            requiredPaths.has(issue.path)
        ) {
            continue;
        }
        const key = `${issue.type}\u0000${issue.path}\u0000${issue.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(issue);
    }
    return normalized;
}

function issueScore(issues: readonly ArgumentIssue[]): number {
    return issues.reduce(
        (score, issue) =>
            score + 10 + (issue.type === ValueErrorType.ObjectAdditionalProperties ? 4 : 0),
        0,
    );
}

function simpleUnionExpectation(schema: TSchema): string | undefined {
    const variants = (schema as TSchema & { anyOf?: unknown }).anyOf;
    if (!Array.isArray(variants) || variants.length < 2) return undefined;
    const alternatives = variants.map((variant): string | undefined => {
        if (typeof variant !== "object" || variant === null) return undefined;
        if (Object.hasOwn(variant, "const")) {
            const literal = (variant as { const: unknown }).const;
            return literal === null ? "null" : JSON.stringify(literal);
        }
        const type = (variant as { type?: unknown }).type;
        return typeof type === "string" && type !== "object" && type !== "array" ? type : undefined;
    });
    if (alternatives.some((alternative) => alternative === undefined)) return undefined;
    const unique = [...new Set(alternatives as string[])];
    if (unique.length < 2) return undefined;
    if (unique.length === 2) return `Expected ${unique[0]} or ${unique[1]}`;
    return `Expected one of ${unique.slice(0, -1).join(", ")}, or ${unique.at(-1)}`;
}

function issuesFor(errors: Iterable<ValueError>): ArgumentIssue[] {
    const issues: ArgumentIssue[] = [];
    for (const error of errors) {
        if (error.type !== ValueErrorType.Union || error.errors.length === 0) {
            issues.push(error);
            continue;
        }

        const simpleExpectation = simpleUnionExpectation(error.schema);
        if (simpleExpectation !== undefined) {
            issues.push({ ...error, message: simpleExpectation });
            continue;
        }

        // Object unions can describe substantially different call forms. Report the form that
        // requires the fewest corrections, penalizing unknown properties so a form which already
        // recognizes the supplied fields wins a tie.
        const candidates = error.errors.map((candidate) => issuesFor(candidate));
        const closest = candidates.reduce<ArgumentIssue[] | undefined>((best, candidate) => {
            if (best === undefined || issueScore(candidate) < issueScore(best)) return candidate;
            return best;
        }, undefined);
        if (closest === undefined || closest.length === 0) {
            issues.push(error);
        } else {
            issues.push(...closest);
        }
    }
    return normalizedIssues(issues);
}

function argumentPath(pointer: string): string {
    if (pointer.length === 0) return "(arguments)";
    const segments = pointer
        .split("/")
        .slice(1)
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
    let path = "";
    for (const segment of segments) {
        if (/^(?:0|[1-9]\d*)$/.test(segment)) {
            path += `[${segment}]`;
        } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
            path += path.length === 0 ? segment : `.${segment}`;
        } else {
            path += `[${JSON.stringify(segment)}]`;
        }
    }
    return path.length === 0 ? "(arguments)" : path;
}

function receivedValue(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return `array (length ${value.length})`;
    switch (typeof value) {
        case "string":
            return `string (length ${value.length})`;
        case "number":
            return `number (${String(value)})`;
        case "bigint":
            return `bigint (${String(value)})`;
        case "boolean":
            return `boolean (${String(value)})`;
        case "object":
            return `object (${Object.keys(value).length} properties)`;
        default:
            return typeof value;
    }
}

function formatIssue(issue: ArgumentIssue): string {
    const path = argumentPath(issue.path);
    if (issue.type === ValueErrorType.ObjectRequiredProperty) {
        return `- ${path}: Required property is missing.`;
    }
    if (issue.type === ValueErrorType.ObjectAdditionalProperties) {
        return `- ${path}: Unexpected property.`;
    }
    const message = issue.message
        .replaceAll("less or equal to", "less than or equal to")
        .replaceAll("greater or equal to", "greater than or equal to")
        .replace(/[.]$/, "");
    return `- ${path}: ${message}; received ${receivedValue(issue.value)}.`;
}

/** Return the model-facing error for invalid arguments, or `undefined` when they are valid. */
export function agentToolArgumentsError(
    toolName: string,
    schema: TSchema,
    value: unknown,
): string | undefined {
    const issues = issuesFor(Value.Errors(schema, value));
    if (issues.length === 0) return undefined;

    const lines = issues.slice(0, MAX_REPORTED_ARGUMENT_ISSUES).map(formatIssue);
    const omitted = issues.length - lines.length;
    if (omitted > 0) {
        lines.push(
            `- ${omitted} more validation ${omitted === 1 ? "issue was" : "issues were"} omitted.`,
        );
    }
    return [`The arguments for "${toolName}" did not match its schema:`, ...lines].join("\n");
}
