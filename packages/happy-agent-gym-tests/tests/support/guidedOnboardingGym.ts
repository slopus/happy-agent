import {
    GYM_MODELS,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { expect } from "vitest";

import {
    OnboardingGyms,
    press,
    textOf,
    waitForStep,
    type OnboardingFlow,
} from "./onboardingGym.js";

/**
 * The conversation's own model leading onboarding once an AI is connected. Codex is a stand-in
 * inside a stand-in ChatGPT app, signed in by a fake auth file; its account is a scripted provider
 * registered as Codex, so every answer is the gym's and nothing leaves this machine.
 */

const CODEX = `#!/bin/sh
case "$*" in
  "--version") echo "codex-cli 0.164.0" ;;
  "login status") echo "Logged in using ChatGPT" ;;
  *) exit 2 ;;
esac
`;

/** A stand-in Claude Code, signed in as Ada on Max. */
const CLAUDE = `#!/bin/sh
case "$*" in
  "--version") echo "2.1.312 (Claude Code)" ;;
  "auth status --json") echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com","subscriptionType":"max"}' ;;
  *) exit 2 ;;
esac
`;

/** The model's first message: what is connected, the profile it saved, and the first task asked. */
export const FIRST_TASK_ASKED = [
    "Connected to ChatGPT as ada@example.com. Your agents think with it from now on, on Gym Codex · Medium unless you pick another model.",
    "",
    "I've put **Ada Lovelace** · ada@example.com on your profile, from your Git settings, so your agents know who they work for, and I'll go by Ada's Chief of Staff. Change either anytime.",
    "",
    "Now let's give them real work. With your permission, I'll look at the projects you worked on recently on this computer and their Git history, without changing anything, and suggest where agents can help first.",
    "",
    "<menu>",
    '  <button data-action="reply" data-emphasis>Look at my recent work</button>',
    '  <button data-action="reply">I\'ll name a folder</button>',
    '  <button data-action="reply">Skip for now</button>',
    "</menu>",
].join("\n");

export const PHONE_STEP = [
    "Your agents keep working while you step away. Put Happy on your phone, and you can see them finish and answer their questions from anywhere. Scan a code to get the app, then open it.",
    "",
    "<figure data-phone-app></figure>",
    "",
    "<menu>",
    '  <button data-action="reply" data-emphasis>I\'ve opened Happy</button>',
    '  <button data-action="reply">Later</button>',
    "</menu>",
].join("\n");

export const DONE =
    "You're all set, Ada. I stay at the top of your sidebar. Tell me what you want done next, and I'll put agents on it. Ask me for the phone code anytime.";

export const SAVE_PROFILE = {
    content: [
        {
            type: "tool_call" as const,
            name: "save_profile",
            arguments: { name: "Ada Lovelace", email: "ada@example.com" },
        },
    ],
};

function jwt(claims: object): string {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "none" })}.${part(claims)}.signature`;
}

export const RENAME = {
    content: [
        {
            type: "tool_call" as const,
            name: "set_bot_name",
            arguments: { name: "Ada's Chief of Staff" },
        },
    ],
};

/** The hidden onboarding events in one model message, oldest first. */
export function eventsIn(
    message: GymInferenceRequest["messages"][number] | undefined,
): Record<string, unknown>[] {
    if (
        message === undefined ||
        !("content" in message) ||
        message.content === null ||
        typeof message.content === "string"
    ) {
        return [];
    }
    const text = message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
    return [...text.matchAll(/<happy-onboarding-event>\n(.*?)\n<\/happy-onboarding-event>/gu)].map(
        (match) => JSON.parse(match[1]!) as Record<string, unknown>,
    );
}

/**
 * What a request answers: the newest hidden event's kind, with a task update's state; the
 * person's words; or a tool's result.
 */
export function cue(request: GymInferenceRequest): string {
    const last = request.messages.at(-1);
    const text = JSON.stringify(last ?? {});
    const event = eventsIn(last).at(-1);
    if (event !== undefined) {
        return event["kind"] === "taskUpdated"
            ? `event:taskUpdated:${String(event["state"])}`
            : `event:${String(event["kind"])}`;
    }
    if (last?.role === "user") {
        return `said:${last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")}`;
    }
    if (text.includes("Saved their name and email")) return "saved";
    if (text.includes("Onboarding is finished")) return "finished";
    if (text.includes("Not finished.")) return "not finished";
    if (text.includes("as a top-level task")) return "started";
    if (text.includes("The bot is now named")) return "renamed";
    if (text.includes("The default is now")) return "model set";
    if (
        /No recent projects found|Recent projects on this computer|The folder they named|There is no folder at/u.test(
            text,
        )
    ) {
        return "looked";
    }
    return `unknown:${text.slice(0, 200)}`;
}

export async function startGuidedGym(
    gyms: OnboardingGyms,
    answers: Record<string, (request: GymInferenceRequest) => GymTurn>,
    options: {
        /** Claude Code signed in too, beside Codex. */
        readonly claude?: boolean;
        /** The kind of device the start names. */
        readonly device?: string;
    } = {},
): Promise<{ gym: AgentGym; agentId: string; home: string }> {
    const codex = "Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
    let onboarding: string | undefined;
    const { gym, home } = await gyms.start({
        machine: {
            [codex]: { content: CODEX, mode: 0o755 },
            "home/.codex/auth.json": JSON.stringify({
                tokens: {
                    id_token: jwt({
                        email: "ada@example.com",
                        "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
                    }),
                },
            }),
            "home/.gitconfig": "[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n",
            ...(options.claude === true
                ? { "home/.local/bin/claude": { content: CLAUDE, mode: 0o755 } }
                : {}),
        },
        providerIds: options.claude === true ? ["gym", "codex", "claude"] : ["gym", "codex"],
        providerTypes:
            options.claude === true ? { codex: "codex", claude: "claude" } : { codex: "codex" },
        models: [
            ...GYM_MODELS,
            {
                defaultEffort: "medium",
                effortLevels: ["low", "medium", "high"],
                id: "gym-codex",
                name: "Gym Codex",
                providerId: "codex",
            },
            ...(options.claude === true
                ? [
                      {
                          defaultEffort: "high" as const,
                          effortLevels: ["low" as const, "medium" as const, "high" as const],
                          id: "gym-claude",
                          name: "Gym Claude",
                          providerId: "claude",
                      },
                  ]
                : []),
        ],
        inference: (request) => {
            if (request.sessionId.startsWith("naming:")) {
                return {
                    content: [{ text: "<title>Chief</title><slug>chief</slug>", type: "text" }],
                };
            }
            // A task the Chief of Staff started runs in a conversation of its own.
            if (onboarding !== undefined && request.sessionId !== onboarding) {
                const elsewhere = answers["elsewhere"];
                if (elsewhere === undefined) throw new Error("Unscripted request elsewhere.");
                return elsewhere(request);
            }
            const answer = answers[cue(request)];
            if (answer === undefined) throw new Error(`Unscripted request: ${cue(request)}`);
            return answer(request);
        },
    });
    const { flow } = (await gym.http.ok(
        "POST",
        "/v0/onboarding/flow/start",
        options.device === undefined ? {} : { device: options.device },
    )) as { flow: OnboardingFlow };
    onboarding = flow.agentId!;
    return { gym, agentId: onboarding, home };
}

/** Use selected on the routes table with `values` ticked. */
export async function useRoutes(gym: AgentGym, agentId: string, values: string[]): Promise<void> {
    const routes = (await waitForStep(gym, agentId, "providers"))!;
    expect(textOf(routes)).toContain(
        "I found these on this computer. Choose the ones I should use.",
    );
    await press(gym, agentId, { messageId: routes.id, params: { step: "use" }, values });
}

/** Press a `reply` control: `controlIndex` in the menu at `blockIndex`, after any figure. */
export async function reply(
    gym: AgentGym,
    agentId: string,
    messageId: string,
    controlIndex: number,
    blockIndex = 0,
    /** The control's `data-text`, which a reply press names as its `text` parameter. */
    text?: string,
) {
    const response = await gym.http.request("POST", `/v0/agents/${agentId}/send`, {
        mode: {
            ...gym.selection,
            providerId: "codex",
            modelId: "gym-codex",
            permissionMode: "auto",
        },
        content: [
            {
                type: "action",
                messageId,
                blockIndex,
                controlIndex,
                actionId: "reply",
                params: text === undefined ? {} : { text },
            },
        ],
    });
    expect(response.status, response.text).toBe(202);
    return response.body as { message: { id: string; content: { type: string; text?: string }[] } };
}
