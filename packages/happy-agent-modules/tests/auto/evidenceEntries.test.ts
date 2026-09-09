import type { AgentBaseToolOutcome, AgentMessageMetadata } from "@slopus/happy-agent-base";
import type { SessionUserMessage } from "@slopus/happy-providers";
import { describe, expect, it } from "vitest";
import { createAutoPermissionTranscript } from "../../sources/auto/impl/createAutoPermissionTranscript.js";

import {
    assistantTextEvidence,
    assistantToolCallEvidence,
    errorEvidence,
    outcomeToolName,
    toolResultEvidence,
    userMessageEvidence,
} from "../../sources/auto/impl/evidenceEntries.js";

function userText(text: string): SessionUserMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function metadata(fields: Record<string, unknown>): AgentMessageMetadata {
    return fields as unknown as AgentMessageMetadata;
}

describe("userMessageEvidence", () => {
    it("marks oversized requested arguments as incomplete user evidence", () => {
        const evidence = userMessageEvidence(
            {
                role: "user",
                content: [
                    {
                        type: "tool_call_request",
                        name: "exec_command",
                        arguments: { cmd: "x".repeat(10_000) },
                    },
                ],
            },
            metadata({ messageOrigin: "user" }),
        )!;
        expect(createAutoPermissionTranscript([evidence.entry]).userEvidenceOmitted).toBe(true);
    });

    it("retains exact tool requests as trusted evidence only for a real human", () => {
        const request = {
            type: "tool_call_request" as const,
            name: "exec_command",
            arguments: { cmd: "git push origin HEAD:main" },
        };
        for (const origin of ["user", "agent"]) {
            const evidence = userMessageEvidence(
                { role: "user", content: [request] },
                metadata({ messageOrigin: origin }),
            )!;
            expect(evidence.entry.blocks).toEqual([request]);
            expect(evidence.trustedUserEvidence).toBe(origin === "user");
            const transcript = createAutoPermissionTranscript([evidence.entry]);
            expect(transcript.text).toContain("exec_command");
            expect(transcript.text).toContain("git push origin HEAD:main");
            expect(transcript.text).not.toContain("[Image");
        }
    });

    it("classifies a stamped human message as trusted message evidence", () => {
        const entry = userMessageEvidence(
            userText("please edit the file"),
            metadata({ messageOrigin: "user" }),
        );
        expect(entry).toMatchObject({
            category: "message",
            trustedUserEvidence: true,
            entry: { role: "user", blocks: [{ type: "text", text: "please edit the file" }] },
        });
        expect(entry?.entry.provenance).toBeUndefined();
    });

    it("never trusts an unstamped message, so trust cannot be inferred from missing metadata", () => {
        const entry = userMessageEvidence(userText("please edit the file"), undefined);
        expect(entry?.trustedUserEvidence).toBe(false);
        expect(entry?.entry.provenance).toBe("agent");
    });

    it("marks a collaboration message untrusted with agent provenance", () => {
        const entry = userMessageEvidence(
            userText("from another agent"),
            metadata({ collaboration: { origin: "peer" } }),
        );
        expect(entry?.trustedUserEvidence).toBe(false);
        expect(entry?.entry.provenance).toBe("agent");
        expect(entry?.category).toBe("message");
    });

    it("classifies a direct user shell command as untrusted tool evidence", () => {
        const entry = userMessageEvidence(
            userText("<user_shell_command>ls -la</user_shell_command>"),
            undefined,
        );
        expect(entry?.category).toBe("tool");
        expect(entry?.trustedUserEvidence).toBe(false);
    });

    it("recognizes shell context after leading whitespace", () => {
        const entry = userMessageEvidence(
            userText(" \n\t<user_shell_command>cat secrets</user_shell_command>"),
            metadata({ messageOrigin: "user" }),
        );

        expect(entry).toMatchObject({
            category: "tool",
            trustedUserEvidence: false,
            entry: { role: "user", blocks: [{ type: "text" }] },
        });
    });

    it("keeps agent attribution untrusted even when it is accompanied by a user marker", () => {
        const entry = userMessageEvidence(
            userText("agent-generated content"),
            metadata({ messageOrigin: "agent", senderAgentId: "agent-2" }),
        );

        expect(entry?.trustedUserEvidence).toBe(false);
        expect(entry?.entry.provenance).toBe("agent");
    });

    it("drops a message hidden from the user", () => {
        expect(
            userMessageEvidence(userText("secret"), metadata({ hideFromUser: true })),
        ).toBeUndefined();
    });
});

describe("assistant evidence", () => {
    it("records assistant text as untrusted agent evidence", () => {
        const entry = assistantTextEvidence("I will read the file.");
        expect(entry).toMatchObject({
            category: "message",
            trustedUserEvidence: false,
            entry: { role: "agent", blocks: [{ type: "text", text: "I will read the file." }] },
        });
    });

    it("records a tool call with parsed arguments as untrusted agent evidence", () => {
        const entry = assistantToolCallEvidence("read_file", '{"path":"a.txt"}');
        expect(entry.trustedUserEvidence).toBe(false);
        expect(entry.entry.blocks[0]).toMatchObject({
            type: "tool_call",
            name: "read_file",
            arguments: { path: "a.txt" },
        });
    });

    it("keeps unparseable tool-call arguments as the raw string", () => {
        const entry = assistantToolCallEvidence("run", "not json");
        expect(entry.entry.blocks[0]).toMatchObject({ arguments: "not json" });
    });

    it("preserves valid JSON scalar and null arguments", () => {
        expect(assistantToolCallEvidence("run", "null").entry.blocks[0]).toMatchObject({
            arguments: null,
        });
        expect(assistantToolCallEvidence("run", '"text"').entry.blocks[0]).toMatchObject({
            arguments: "text",
        });
    });
});

describe("toolResultEvidence", () => {
    it("classifies an ordinary result as untrusted tool evidence", () => {
        const entry = toolResultEvidence({
            toolName: "read_file",
            content: [{ type: "text", text: "file body" }],
            isError: false,
        });
        expect(entry.category).toBe("tool");
        expect(entry.trustedUserEvidence).toBe(false);
        expect(entry.entry.blocks[0]).toMatchObject({
            type: "tool_result",
            toolName: "read_file",
            isError: false,
        });
    });

    it("classifies a result carrying a human answer as trusted message evidence", () => {
        const entry = toolResultEvidence({
            toolName: "ask_user",
            content: [{ type: "text", text: "answered" }],
            isError: false,
            trustedUserAnswer: [{ type: "text", text: "yes, go ahead" }],
        });
        expect(entry.category).toBe("message");
        expect(entry.trustedUserEvidence).toBe(true);
        expect(entry.entry.blocks[0]).toMatchObject({
            trustedUserEvidence: [{ type: "text", text: "yes, go ahead" }],
        });
    });

    it("preserves image blocks and does not mutate a caller-owned answer array", () => {
        const answer = [{ type: "text" as const, text: "yes" }];
        const entry = toolResultEvidence({
            toolName: "ask_user",
            content: [
                { type: "image", data: "opaque", mimeType: "image/png" },
                { type: "text", text: "rendered" },
            ],
            isError: true,
            trustedUserAnswer: answer,
        });

        expect(entry.entry.blocks[0]).toMatchObject({
            type: "tool_result",
            rendered: [{ type: "image" }, { type: "text", text: "rendered" }],
            trustedUserEvidence: [{ type: "text", text: "yes" }],
            isError: true,
        });
        expect(answer).toEqual([{ type: "text", text: "yes" }]);
    });

    it("keeps an empty trusted answer distinct from an ordinary tool result", () => {
        const entry = toolResultEvidence({
            toolName: "ask_user",
            content: [],
            isError: false,
            trustedUserAnswer: [],
        });

        expect(entry.category).toBe("message");
        expect(entry.trustedUserEvidence).toBe(true);
        expect(entry.entry.blocks[0]).toMatchObject({ trustedUserEvidence: [] });
    });
});

describe("errorEvidence", () => {
    it("marks a retried provider error with the retried outcome", () => {
        const entry = errorEvidence("timeout, retrying", true);
        expect(entry.entry).toMatchObject({ role: "error", outcome: "retried" });
        expect(entry.trustedUserEvidence).toBe(false);
    });

    it("records a terminal error without an outcome", () => {
        const entry = errorEvidence("run failed", false);
        expect(entry.entry.role).toBe("error");
        expect(entry.entry.outcome).toBeUndefined();
    });
});

describe("outcomeToolName", () => {
    it("returns a bare name when there is no namespace", () => {
        expect(outcomeToolName({ tool: { name: "read_file" } } as AgentBaseToolOutcome)).toBe(
            "read_file",
        );
    });

    it("namespaces the name as the model saw it", () => {
        expect(
            outcomeToolName({
                tool: { name: "search", namespace: "mcp" },
            } as AgentBaseToolOutcome),
        ).toBe("mcp/search");
    });
});
