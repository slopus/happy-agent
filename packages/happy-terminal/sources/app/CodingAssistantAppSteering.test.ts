import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingAssistantApp } from "./CodingAssistantApp.js";
import type {
    CodingAssistantAgentBackend,
    SteeringSubmissionResponse,
} from "./CodingAssistantAgentBackend.js";
import { stripAnsi } from "./testing/stripAnsi.js";

afterEach(() => vi.useRealTimers());

describe("accepted steering at a run boundary", () => {
    it("does not restore a durable accepted prompt when its acknowledgement follows the old run finish", async () => {
        vi.useFakeTimers();
        let acknowledge!: (response: SteeringSubmissionResponse) => void;
        const steer = vi.fn(
            () =>
                new Promise<SteeringSubmissionResponse>((resolve) => {
                    acknowledge = resolve;
                }),
        );
        const model = { id: "openai/gym", name: "Gym", defaultThinkingLevel: "off" };
        const agent = {
            id: "agent",
            model,
            provider: { id: "gym", models: [model] },
            permissionMode: "read_only",
            canChangeModel: true,
            snapshot: () => ({ id: "agent", messages: [], status: "idle" }),
            steer,
        } as unknown as CodingAssistantAgentBackend;
        const app = new CodingAssistantApp({
            agent,
            cwd: process.cwd(),
            ctx: {} as never,
            processManager: {} as never,
            sessionBacked: true,
            tui: { requestRender: vi.fn(), terminal: { columns: 120, rows: 30 } } as unknown as TUI,
        });
        app.applySessionEvent({
            id: "started",
            sessionId: "agent",
            createdAt: 1,
            type: "run_started",
            data: { runId: "oldrun" },
        });
        app.handleInput("Accepted follow-up");
        app.handleInput("\r");
        await Promise.resolve();
        expect(steer).toHaveBeenCalledOnce();
        app.applySessionEvent({
            id: "finished",
            sessionId: "agent",
            createdAt: 2,
            type: "run_finished",
            data: { runId: "oldrun", stopReason: "stop", modelLocked: false },
        });
        acknowledge({ delivery: "pending", messageId: "durablemessage" });
        await Promise.resolve();
        await Promise.resolve();
        const rendered = stripAnsi(app.render(120).join("\n"));
        expect(rendered).toContain("Ask Happy Terminal to do anything");
        expect(rendered).not.toContain("Accepted follow-up");
    });
});
