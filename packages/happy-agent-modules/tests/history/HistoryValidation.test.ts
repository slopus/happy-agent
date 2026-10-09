import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { historyMessageSchema } from "../../sources/history/HistoryMessage.js";
import { historyValidator } from "../../sources/history/impl/historyValidator.js";

describe("compiled history validation", () => {
    it("reuses one validator for a schema without retaining validated values", () => {
        const schema = Type.Object({ value: Type.String() }, { additionalProperties: false });
        const validator = historyValidator(schema);
        const input: { value: unknown } = { value: "valid" };
        expect(validator.Check(input)).toBe(true);
        input.value = 1;
        expect(validator.Check(input)).toBe(false);
        expect(historyValidator(schema)).toBe(validator);
        expect(historyValidator(Type.Object({ value: Type.String() }))).not.toBe(validator);
    });

    it("preserves recursive refs, unions, optionals and closed object semantics", () => {
        const schema = Type.Recursive((self) =>
            Type.Object(
                {
                    value: Type.Union([Type.String({ maxLength: 3 }), Type.Null()]),
                    next: Type.Optional(self),
                },
                { additionalProperties: false },
            ),
        );
        const validator = historyValidator(schema);
        for (const input of [
            { value: "yes" },
            { value: null, next: { value: "ok" } },
            { value: "long" },
            { value: "yes", extra: true },
            { value: null, next: { value: 1 } },
            {},
            null,
        ]) {
            expect(validator.Check(input)).toBe(Value.Check(schema, input));
        }
    });

    it("matches the existing schema on nested tool calls and corrupted messages", () => {
        const valid = {
            recordId: "message-a",
            role: "assistant",
            blocks: [
                {
                    type: "tool_call",
                    callId: "callone",
                    name: "exec_command",
                    arguments: { nested: [null, true, { cmd: "echo hello" }] },
                },
                {
                    type: "tool_result",
                    callId: "callone",
                    toolName: "exec_command",
                    output: "hello",
                },
            ],
        };
        const inputs: unknown[] = [
            valid,
            { ...valid, role: "unknown" },
            { ...valid, recordId: "bad\nidentity" },
            { ...valid, at: -1 },
            { ...valid, extra: "field" },
            { ...valid, blocks: [{ ...valid.blocks[0], callId: "bad-id" }] },
            { ...valid, blocks: [{ ...valid.blocks[0], arguments: { bad: undefined } }] },
            { ...valid, blocks: [{ ...valid.blocks[1], extra: true }] },
            { ...valid, blocks: [{ type: "text", text: 7 }] },
            { ...valid, blocks: [{ type: "thinking", thinking: "reason", redacted: false }] },
            { ...valid, blocks: [{ type: "image", mediaType: "image/png", data: "AA==" }] },
            null,
        ];
        const validator = historyValidator(historyMessageSchema);
        expect(validator.Check(valid)).toBe(true);
        for (const input of inputs) {
            expect(validator.Check(input)).toBe(Value.Check(historyMessageSchema, input));
        }
    });
});
