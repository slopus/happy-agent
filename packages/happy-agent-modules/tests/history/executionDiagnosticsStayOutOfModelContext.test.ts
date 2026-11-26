import { Value } from "@sinclair/typebox/value";
import { configurationBlockSchema, messageErrorSchema } from "@slopus/happy-agent-client";
import { describe, expect, it } from "vitest";

import { messageResource } from "../../sources/api/ApiMessageProjection.js";
import { HistoryModule, type HistoryMessage } from "../../sources/history/index.js";
import { formatHistoryMessage } from "../../sources/history/impl/formatHistoryMessage.js";
import {
    configuration,
    diagnostic,
    diagnosticMessage,
    diagnosticText,
} from "../support/credentialDiagnostic.js";
import { defaultMode } from "../support/fixtures.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

describe("execution diagnostics are display-only history", () => {
    it("retains a canonical error under its original identity and preserves multiline text", async () => {
        expect(Value.Check(messageErrorSchema, diagnostic)).toBe(true);
        const history = new HistoryModule();
        const database = moduleDatabase(history.migrations, "diagnostic-history");
        await database.ready;
        try {
            await history.record(database.context, "agent-a", diagnosticMessage);
            const stored = await history.message(
                database.context,
                "agent-a",
                diagnosticMessage.recordId,
            );
            expect(stored).toEqual(diagnosticMessage);
            expect(messageResource(stored!, { defaultMode })).toMatchObject({
                id: diagnosticMessage.recordId,
                role: "service",
                content: [{ type: "text", text: diagnosticText }],
                error: diagnostic,
            });
        } finally {
            database.close();
        }
    });

    it("does not expose error provenance through the model-readable formatter", () => {
        const formatted = formatHistoryMessage(diagnosticMessage, 0);
        expect(formatted).toContain(diagnosticText);
        expect(formatted).not.toContain("PRIVATE_PROVIDER_TOKEN");
        expect(formatted).not.toContain("private-login-host");
        expect(formatted).not.toContain("private-login-command");
    });

    it("skips configuration-only rows instead of presenting them as compactions", () => {
        expect(Value.Check(configurationBlockSchema, configuration)).toBe(true);
        // Published canonical configuration blocks intentionally precede their internal schema.
        const message = {
            role: "service",
            recordId: "configuration-message",
            blocks: [configuration],
        } as unknown as HistoryMessage;
        expect(formatHistoryMessage(message, 0)).toBe("");
    });

    it("preserves unrelated prose beside a configuration block without exposing its snapshot", () => {
        const message = {
            role: "service",
            recordId: "mixed-service-message",
            blocks: [configuration, { type: "text", text: "Visible service text." }],
        } as unknown as HistoryMessage;
        expect(formatHistoryMessage(message, 0)).toBe("0. SERVICE\nText: Visible service text.");
    });
});
