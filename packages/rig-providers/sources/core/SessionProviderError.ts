import { Type, type Static } from "@sinclair/typebox";

const diagnosticTextSchema = Type.String({ maxLength: 2_048, minLength: 1 });
const diagnosticIdentifierSchema = Type.String({ maxLength: 256, minLength: 1 });

export const sessionProviderErrorDiagnosticsSchema = Type.Object(
    {
        attempts: Type.Optional(Type.Integer({ minimum: 1 })),
        code: Type.Optional(diagnosticIdentifierSchema),
        errorType: Type.Optional(diagnosticIdentifierSchema),
        requestId: Type.Optional(diagnosticIdentifierSchema),
        responseId: Type.Optional(diagnosticIdentifierSchema),
        retryDirective: Type.Optional(Type.Boolean()),
        status: Type.Optional(Type.Integer({ maximum: 999, minimum: 0 })),
        upstreamMessage: Type.Optional(diagnosticTextSchema),
    },
    { additionalProperties: false },
);

export type SessionProviderErrorDiagnostics = Static<typeof sessionProviderErrorDiagnosticsSchema>;

const diagnosticFields = {
    diagnostics: Type.Optional(sessionProviderErrorDiagnosticsSchema),
};

/** Provider failure details that remain meaningful above a native session transport. */
export const sessionProviderErrorSchema = Type.Union([
    Type.Object(
        { type: Type.Literal("authentication"), ...diagnosticFields },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("out_of_tokens"),
            resetAt: Type.Optional(Type.Number({ minimum: 0 })),
            ...diagnosticFields,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("rate_limit"),
            resetAt: Type.Optional(Type.Number({ minimum: 0 })),
            ...diagnosticFields,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        { type: Type.Literal("server_overloaded"), ...diagnosticFields },
        { additionalProperties: false },
    ),
    Type.Object(
        { type: Type.Literal("internal_server_error"), ...diagnosticFields },
        { additionalProperties: false },
    ),
    Type.Object(
        { type: Type.Literal("empty_response"), ...diagnosticFields },
        { additionalProperties: false },
    ),
    Type.Object(
        { type: Type.Literal("unclassified"), ...diagnosticFields },
        { additionalProperties: false },
    ),
]);

export type SessionProviderError = Static<typeof sessionProviderErrorSchema>;
