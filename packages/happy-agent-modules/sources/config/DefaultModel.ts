import { Type, type Static } from "@sinclair/typebox";

/** The model new conversations start on, as `PATCH /v0/config` `defaults` sets it. */
export const defaultModelUpdateSchema = Type.Object(
    {
        providerId: Type.String({ minLength: 1, maxLength: 200 }),
        modelId: Type.String({ minLength: 1, maxLength: 500 }),
        effort: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    },
    { additionalProperties: false },
);
export type DefaultModelUpdate = Static<typeof defaultModelUpdateSchema>;

/** A default model the daemon cannot use: an unknown route, or an effort the model refuses. */
export class DefaultModelError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DefaultModelError";
    }
}
