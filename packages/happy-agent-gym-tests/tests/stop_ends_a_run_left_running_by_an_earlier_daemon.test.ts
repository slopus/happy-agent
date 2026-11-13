import { createAgentGym, runGymSql } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";

/**
 * An earlier daemon could leave a run `running` on disk with no loop behind it: a late steer kept
 * the run open, and a Stop then dropped the turn that would have accepted it. A restart restores
 * nothing for such a run, so every snapshot said working and Stop found no turn to cancel. Stop
 * must now end that run, announce it finished, and leave the agent idle.
 */
it("ends a run an earlier daemon left running when the agent is stopped", async () => {
    const gym = await createAgentGym({
        timeoutMs: 30_000,
        inference: () => ({ content: [{ type: "text", text: "Done." }] }),
    });
    try {
        const { runId } = await gym.send("Finish this turn.");
        await gym.restart({
            whileStopped: async () =>
                await runGymSql(gym.happyHome, [
                    `UPDATE happy_agent_module_history_runs
                        SET status = 'running', reason = NULL, ended_at = NULL
                        WHERE run_id = '${runId}'`,
                ]),
        });
        expect((await gym.getSession()).status).toBe("working");

        const before = (await gym.client.getEvents()).latestCursor;
        await gym.abort();
        expect((await gym.getSession()).status).toBe("idle");
        const finished = await gym.waitUntil(async () =>
            (await gym.client.getEvents({ after: before })).events.find(
                (event) =>
                    event.type === "run.finished" &&
                    (event.payload as { run: { id: string } }).run.id === runId,
            ),
        );
        expect(finished.payload).toMatchObject({
            run: { id: runId, status: "aborted", reason: "abort" },
        });
    } finally {
        await gym.dispose();
    }
}, 120_000);
