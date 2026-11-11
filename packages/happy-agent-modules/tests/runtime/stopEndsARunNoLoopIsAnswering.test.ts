import { createId } from "@paralleldrive/cuid2";
import type { HappyAgentEvent } from "@slopus/happy-agent-client";
import { expect, it } from "vitest";
import { credentialWriterRuntime } from "../support/credentialWriterRuntime.js";

/**
 * An earlier daemon could leave a run `running` with no loop answering it, and the agent then read
 * as working in every snapshot, through Stop and restart alike. Stop must end such a run, announce
 * it finished, and leave the agent idle.
 */
it("ends a running run that no loop is answering when the agent is stopped", async () => {
    const fixture = await credentialWriterRuntime("owner");
    const agentId = fixture.agent.id;
    const history = fixture.runtime.modules.history;
    try {
        const runId = createId();
        // The state an interrupted steering boundary used to leave on disk.
        await history.beginMaintenanceRun(fixture.ctx, agentId, runId, Date.now());
        await fixture.restart();
        expect((await fixture.owner.getAgent(agentId)).agent.status).toBe("working");

        const before = (await fixture.owner.getEvents()).latestCursor;
        const stopped = await fixture.owner.abortAgent(agentId);
        expect(stopped.agent.status).toBe("idle");
        expect((await fixture.owner.getAgent(agentId)).agent.status).toBe("idle");
        expect(await history.run(fixture.ctx, agentId, runId)).toMatchObject({
            status: "aborted",
            reason: "abort",
        });
        const finished = (await fixture.owner.getEvents({ after: before })).events.filter(
            (event: HappyAgentEvent) =>
                event.type === "run.finished" &&
                (event.payload as { run: { id: string } }).run.id === runId,
        );
        expect(finished).toHaveLength(1);
    } finally {
        await fixture.close();
    }
}, 60_000);
