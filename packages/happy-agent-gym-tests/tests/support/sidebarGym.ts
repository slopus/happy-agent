import { createAgentGym, type GymInferenceRequest, type GymTurn } from "@slopus/happy-agent-gym";

export type SidebarDocument = {
    artifactId: string;
    version: number;
    html: string;
    spaces: {
        id: string;
        title: string | null;
        target: { id: string; agentId: string | null };
        working: boolean;
        icon: { type: string; slug?: string } | null;
    }[];
    agentIcons?: Record<string, { type: string; slug: string }>;
    seed?: true;
};
export type SidebarStem = {
    space: {
        id: string;
        target: { id: string; agentId: string };
        placement: string;
        sectionId: string | null;
    };
    agent: { id: string };
};

/**
 * Every operation enters through the real API and the manager's real tool loop. `prioritizing`
 * answers Prioritizing's own turns, such as a notice, before the default reply; `undefined` falls
 * through to it.
 */
export async function sidebarGym(
    options: {
        readonly prioritizing?: (
            request: GymInferenceRequest,
        ) => GymTurn | undefined | Promise<GymTurn | undefined>;
    } = {},
) {
    let command: { token: string; name: string; args: unknown } | undefined;
    let sequence = 0;
    /** While set, Prioritizing's reply after a tool result waits, so its turn stays open. */
    let gate: Promise<void> | undefined;
    const gym = await createAgentGym({
        timeoutMs: 30000,
        inference: async (request) => {
            if (request.instructions.includes("<outcome>"))
                return {
                    content: [
                        {
                            type: "text",
                            text: "<review><outcome>allow</outcome><risk_level>medium</risk_level><user_authorization>high</user_authorization><rationale>Scripted sidebar artifact publication.</rationale></review>",
                        },
                    ],
                };
            // Naming answers with a title far too long for the sidebar, to prove it is cut.
            if (request.instructions.includes("You name a piece of work"))
                return {
                    content: [
                        {
                            type: "text",
                            text: "<title>Sidebar UI fixes and draggable spaces</title>\n<slug>sidebar-ui-fixes</slug>",
                        },
                    ],
                };
            const last = request.messages.at(-1);
            // A notice may join the scenario's request in one run, so every message since the
            // last reply is searched for the request.
            const trailing = request.messages.slice(
                request.messages.findLastIndex((message) => message.role === "assistant") + 1,
            );
            if (
                command !== undefined &&
                trailing.some(
                    (message) =>
                        message.role === "user" && JSON.stringify(message).includes(command!.token),
                )
            ) {
                const call = command;
                command = undefined;
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: call.name,
                            arguments: call.args,
                            callId: call.token,
                        },
                    ],
                };
            }
            if (request.instructions.includes("You are the Focus Agent")) {
                if (gate !== undefined && last?.role === "tool") await gate;
                const turn = await options.prioritizing?.(request);
                if (turn !== undefined) return turn;
            }
            return {
                delayMs:
                    JSON.stringify(last).includes("Keep running") &&
                    !request.instructions.includes("You are the Focus Agent")
                        ? 60000
                        : 0,
                content: [{ type: "text", text: "Done." }],
            };
        },
    });
    await gym.client.saveUserSetting("happy-desktop.experiments.stemCells", { value: true });
    const read = () => gym.http.ok<SidebarDocument>("GET", "/v0/spaces/sidebar");
    const manager = async () =>
        await gym.waitUntil(
            () =>
                gym.inference.requests.find((request) =>
                    request.instructions.includes("You are the Focus Agent"),
                )?.sessionId,
            "Prioritizing's opening turn",
        );
    const call = async (name: string, args: unknown, sessionId?: string) => {
        sessionId ??= await manager();
        const token = `sidebar_scenario_${++sequence}`;
        command = { token, name, args };
        // A turn held open never finishes, so the request is sent without waiting for it.
        await gym.send(`Execute sidebar request ${token}.`, {
            sessionId,
            ...(gate === undefined ? {} : { wait: false }),
        });
        return await gym.waitUntil(
            () => gym.inference.toolResults().find((result) => result.callId === token),
            "the sidebar tool result",
        );
    };
    const edit = async (html: string) => {
        const current = await read();
        return await call("edit_sidebar", {
            baseVersion: current.version,
            edits: [{ oldText: current.html, newText: html }],
        });
    };
    /**
     * Keep Prioritizing's turn open after its next tool call, so its queued changes wait while the
     * scenario acts; the returned function lets the turn finish.
     */
    const holdTurn = () => {
        let release!: () => void;
        gate = new Promise((resolve) => {
            release = resolve;
        });
        return () => {
            gate = undefined;
            release();
        };
    };
    /** Prioritizing's changes apply when its turn ends; wait for that. */
    const settle = async () => {
        const id = await manager();
        await gym.waitUntil(
            async () =>
                (await gym.client.getAgent(id)).agent.status === "idle" ? true : undefined,
            "Prioritizing to finish its turn",
        );
    };
    const create = async (sectionId?: string) =>
        await gym.http.ok<SidebarStem>(
            "POST",
            "/v0/spaces/stem-cells",
            sectionId === undefined ? {} : { sectionId },
        );
    /** The first notice after Prioritizing's opening ends the classic-sidebar seed. */
    const unseed = async () => {
        await manager();
        await gym.http.request("POST", "/v0/spaces/tidy", {});
        await gym.waitUntil(
            async () => ((await read()).seed === undefined ? true : undefined),
            "the end of the seed",
        );
    };
    return { gym, read, call, edit, settle, holdTurn, create, manager, unseed };
}
