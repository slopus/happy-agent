import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type {
    UserInputAnswer,
    UserInputAnswerInput,
    UserInputOptions,
    UserInputRequest,
} from "../userInput/index.js";

const happyAnswerSchema = Type.Object(
    {
        custom: Type.Optional(Type.String()),
        options: Type.Optional(Type.Array(Type.String())),
    },
    { additionalProperties: true },
);

/**
 * Turns what a person tapped on the phone into the answer Happy Agent's question was waiting for.
 *
 * Happy answers a form question with the labels that were chosen and, when the
 * person wrote something of their own, the words they wrote. Happy Agent keeps the two
 * apart: a chosen label must be one it actually offered, and anything else is
 * the person's own text. Sorting them out here is what lets someone answer from
 * the phone with something the agent never thought to offer.
 */
export function resolveHappyUserInputAnswers(
    request: UserInputRequest,
    answers: Record<string, unknown>,
): UserInputAnswerInput {
    if (request.questions === undefined) {
        return {
            answer: readAnswer(answers[request.id], request.options),
            requestId: request.id,
        };
    }
    const resolved: Record<string, UserInputAnswer> = {};
    for (const question of request.questions) {
        resolved[question.id] = readAnswer(answers[question.id], question.options);
    }
    return { answers: resolved, requestId: request.id };
}

function readAnswer(value: unknown, options: UserInputOptions | undefined): UserInputAnswer {
    if (!Value.Check(happyAnswerSchema, value)) return { text: "No answer was given." };
    const offered = new Set(options?.choices.map((choice) => choice.label) ?? []);
    const chosen: string[] = [];
    const written: string[] = [];
    for (const raw of value.options ?? []) {
        const label = raw.trim();
        if (label.length === 0 || chosen.includes(label) || written.includes(label)) continue;
        // A label Happy Agent never offered is not a selection; it is something the person said.
        if (offered.has(label)) chosen.push(label);
        else written.push(label);
    }
    const custom = value.custom?.trim() ?? "";
    if (custom.length > 0 && !chosen.includes(custom) && !written.includes(custom)) {
        written.push(custom);
    }
    // A question that offered one answer cannot be given several.
    const selected = options?.multiSelect === true ? chosen : chosen.slice(0, 1);
    const text = written.join("\n");
    if (selected.length === 0) {
        return { text: text.length === 0 ? "No answer was given." : text };
    }
    return {
        selectedOptions: selected,
        ...(text.length === 0 ? {} : { text }),
    };
}
