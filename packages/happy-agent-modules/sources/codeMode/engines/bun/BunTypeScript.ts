import { Type, type Static } from "@sinclair/typebox";

/** Largest one-shot TypeScript program accepted by the Bun POC. */
export const MAX_CODE_MODE_BUN_CHARACTERS = 32_000;
/** Largest Bun result, including process diagnostics, returned to the conversation. */
export const MAX_CODE_MODE_BUN_OUTPUT_CHARACTERS = 20_000;

export const codeModeJavaScriptInputSchema = Type.Object(
    {
        code: Type.String({ maxLength: MAX_CODE_MODE_BUN_CHARACTERS }),
    },
    { additionalProperties: false },
);

export const codeModeJavaScriptResultSchema = Type.Object(
    {
        output: Type.String({ maxLength: MAX_CODE_MODE_BUN_OUTPUT_CHARACTERS }),
        isError: Type.Boolean(),
    },
    { additionalProperties: false },
);

export type CodeModeJavaScriptInput = Static<typeof codeModeJavaScriptInputSchema>;
export type CodeModeJavaScriptResult = Static<typeof codeModeJavaScriptResultSchema>;
