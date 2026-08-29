import { Type, type Static } from "@sinclair/typebox";

/** Largest one-shot program accepted by the primitive Code Mode interpreter. */
export const MAX_CODE_MODE_PYTHON_CHARACTERS = 100_000;
/** Largest result, including a failure diagnostic, returned to the conversation. */
export const MAX_CODE_MODE_OUTPUT_CHARACTERS = 20_000;

export const codeModePythonInputSchema = Type.Object(
    {
        code: Type.String({ maxLength: MAX_CODE_MODE_PYTHON_CHARACTERS }),
    },
    { additionalProperties: false },
);

export const codeModePythonResultSchema = Type.Object(
    {
        output: Type.String({ maxLength: MAX_CODE_MODE_OUTPUT_CHARACTERS }),
        isError: Type.Boolean(),
    },
    { additionalProperties: false },
);

export type CodeModePythonInput = Static<typeof codeModePythonInputSchema>;
export type CodeModePythonResult = Static<typeof codeModePythonResultSchema>;
