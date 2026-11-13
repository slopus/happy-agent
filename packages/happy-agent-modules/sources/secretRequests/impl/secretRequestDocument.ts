import { Type, type Static } from "@sinclair/typebox";

import {
    secretApiIdSchema,
    secretDescriptionSchema,
    secretEnvironmentVariableNameSchema,
} from "../../secrets/index.js";

/** The element key of the button that opens the secret form, in every secret request card. */
export const SECRET_REQUEST_ELEMENT = "secret";

/** One variable the agent asks for: its name and, optionally, where to find its value. */
export const secretRequestVariableSchema = Type.Object(
    {
        name: Type.String({
            ...secretEnvironmentVariableNameSchema,
            description: "Environment variable name, such as STRIPE_SECRET_KEY.",
        }),
        description: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 2_000,
                description: "What the value is or where the user finds it.",
            }),
        ),
    },
    { additionalProperties: false },
);

/**
 * What an agent asks for. Every field becomes the form's starting point; the person may change
 * all of them. At most 20 variables, one row each of the card's list.
 */
export const secretRequestSchema = Type.Object(
    {
        title: Type.String({
            minLength: 1,
            maxLength: 100,
            pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
            description: 'Short card title, such as "Stripe test keys".',
        }),
        explanation: Type.String({
            minLength: 1,
            maxLength: 4_000,
            description:
                "Inline Markdown shown on the card: why you need the secret and where the user finds each value.",
        }),
        id: Type.Optional(
            Type.String({
                ...secretApiIdSchema,
                description:
                    "Suggested secret name: 2–32 characters, a lowercase letter then lowercase letters, digits, `_`, or `-`. An existing secret's name lets the user change it.",
            }),
        ),
        description: Type.String({
            ...secretDescriptionSchema,
            description: "Suggested description of the secret.",
        }),
        variables: Type.Array(secretRequestVariableSchema, {
            minItems: 1,
            maxItems: 20,
            description: "The environment variables you need, in order.",
        }),
    },
    { additionalProperties: false },
);
export type SecretRequest = Static<typeof secretRequestSchema>;

/**
 * The Gen UI document of a secret request: the agent's explanation, the variables it needs, and
 * one button whose `secret` action prefills the form. `exists` says the suggested name is
 * already a secret, so the button reads as a change.
 */
export function secretRequestDocument(request: SecretRequest, exists: boolean): string {
    const names = request.variables.map((variable) => variable.name).join(", ");
    return JSON.stringify({
        genui: 1,
        fallback: `${request.title}: the agent needs ${names}. Open this in a Happy app to add them as a secret.`,
        root: {
            type: "card",
            title: request.title,
            icon: "lock",
            children: [
                { type: "text", text: request.explanation },
                {
                    type: "list",
                    items: request.variables.map((variable) => ({
                        title: variable.name,
                        icon: "lock",
                        ...(variable.description === undefined
                            ? {}
                            : { subtitle: variable.description }),
                    })),
                },
            ],
            actions: [
                {
                    type: "button",
                    id: SECRET_REQUEST_ELEMENT,
                    label: exists ? "Change secret" : "Add secret",
                    icon: "lock",
                    action: {
                        type: "secret",
                        secret: {
                            ...(request.id === undefined ? {} : { id: request.id }),
                            description: request.description,
                            variables: request.variables,
                        },
                    },
                },
            ],
        },
    });
}
