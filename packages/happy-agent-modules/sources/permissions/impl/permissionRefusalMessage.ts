import { agentPermissionModeLabel, type AgentPermissionMode } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

export const MAX_PERMISSION_REFUSAL_CHARACTERS = 16_384;
export const MAX_PERMISSION_ERROR_CHARACTERS = 1_024;

export const permissionUnprovenKindSchema = Type.Union([
    Type.Literal("timed_out"),
    Type.Literal("unavailable"),
]);

export type PermissionUnprovenKind = Static<typeof permissionUnprovenKindSchema>;

/**
 * What the model is told when a tool cannot be contained by the mode in force. The tool is not
 * refused for this call; it is unavailable until somebody changes the mode, and saying so is what
 * stops a turn spending itself trying the same thing from a different angle.
 */
export function outOfModeRefusal(tool: string, mode: AgentPermissionMode): string {
    return boundRefusal(
        `The tool "${tool}" acts outside the sandbox, so it is unavailable in ` +
            `${agentPermissionModeLabel(mode)} mode. No form of this call will run while the mode ` +
            "stands. Continue with what you can do here, or stop and explain what the work needs.",
    );
}

/** What the model is told when a reviewable tool forgot to define its action boundary. */
export function missingPermissionActionRefusal(tool: string): string {
    return boundRefusal(
        `This tool cannot request Auto approval because its permission action is not defined ` +
            `("${tool}"). The call was refused as a tool-definition error. Do not retry it; the tool ` +
            "definition must be corrected first.",
    );
}

/**
 * What the model is told when a tool's own Auto-mode predicate threw while deciding whether the call
 * needs review or elevation. A throwing predicate has not said the action is safe, so the call is
 * refused as a tool-definition error and never runs — matching Happy Agent v1, which turns a throwing review
 * predicate into a tool error rather than treating it as "no review needed" or "not elevated". The
 * message is fixed so a predicate's internal failure cannot leak into model-facing text.
 */
export function predicateFailedRefusal(tool: string): string {
    return boundRefusal(
        `The tool "${tool}" could not be evaluated for Auto approval because its own permission ` +
            "check failed, so the call did not run. This is a tool-definition error; the tool must " +
            "be corrected before it can run in Auto mode.",
    );
}

/** What the model is told when the tool's review request cannot satisfy the bounded contract. */
export function permissionRequestRefusal(tool: string, reason: string): string {
    return boundRefusal(
        `The tool "${tool}" could not be reviewed because its permission request is invalid. ` +
            `${reason} The call did not run; correct the tool request before trying again.`,
    );
}

/**
 * What the model is told when the reviewer decided this action must not happen. This is Happy Agent v1's
 * exact rejected wording (`describeAutoPermissionDenial`): a fixed sentence carrying only the action
 * and the reviewer's own normalized rationale. No provider error, path, or other detail is ever
 * interpolated, so a refusal cannot leak the reviewer's internal state to the model.
 */
export function deniedRefusal(action: string, reason: string): string {
    return boundRefusal(
        [
            `Automatic permission review refused ${action}.`,
            `Reason: ${reason}`,
            "Do not pursue the same outcome by another route, by splitting it into smaller steps, or by",
            "working around the restriction. Continue only with a materially safer alternative.",
            "Otherwise stop and tell the user what you wanted to do and why it was refused, so they can",
            "decide.",
        ].join(" "),
    );
}

/**
 * What the model is told when the review never happened. This is the absence of a decision rather
 * than a refusal, and the difference is what the model is meant to act on: nothing has judged the
 * action unsafe, so it is unproven, and the answer is to say so rather than to find another route.
 *
 * The wording is Happy Agent v1's exact timed-out and unavailable text (`describeAutoPermissionDenial`) and
 * carries no reason string. A timeout or an unavailable reviewer is expressed entirely by the fixed
 * sentence, so the provider error that caused it is never surfaced to the model.
 */
export function unprovenRefusal(
    action: string,
    kind: PermissionUnprovenKind = "unavailable",
): string {
    if (kind === "timed_out") {
        return boundRefusal(
            [
                `The automatic permission review did not finish in time, so ${action} was not performed.`,
                "The action is unproven rather than unsafe, so do not treat the timeout by itself as a",
                "verdict. You may try once more, or ask the user how to proceed.",
            ].join(" "),
        );
    }
    return boundRefusal(
        [
            `The automatic permission review could not run, so ${action} was not performed.`,
            "No judgement was made about the action itself. Continue with work that does not need",
            "this permission, or ask the user how to proceed.",
        ].join(" "),
    );
}

/**
 * What the model is told when refusal after refusal has ended its turn. The window is the real
 * number of decisions the recent-refusal count was measured over, which early in a turn may be far
 * smaller than the maximum window — telling the model "of the last 50" when only three decisions
 * have happened is simply false, and the TUI projection already reports the true window.
 */
export function turnStoppedNotice(
    consecutive: number,
    recent = consecutive,
    window = recent,
): string {
    return boundRefusal(
        `This turn has been stopped after too many refused actions (${consecutive} in a row, ` +
            `${recent} of the last ${window}). Nothing else will run in it. The person has to decide ` +
            "what happens next.",
    );
}

/**
 * The full sentence recorded on the turn-stopped event, including the directive to the model. This
 * is what the model is meant to act on; the person sees the shorter notice text below, which drops
 * the directive because it is an instruction to the agent rather than something to show a reader.
 */
export function permissionTurnStoppedReason(
    consecutive: number,
    recent: number,
    window: number,
): string {
    return (
        `${permissionTurnStoppedNoticeText(consecutive, recent, window)} ` +
        "Tell the user what you were trying to do and why it kept being refused."
    );
}

/** The user-visible explanation of why the turn stopped, with no agent-facing directive. */
export function permissionTurnStoppedNoticeText(
    consecutive: number,
    recent: number,
    window: number,
): string {
    return (
        `Automatic permission review refused too many actions in this turn (${consecutive} in a ` +
        `row, ${recent} of the last ${window}), so the turn was stopped.`
    );
}

function boundRefusal(message: string): string {
    if (message.length <= MAX_PERMISSION_REFUSAL_CHARACTERS) return message;
    const marker = "\n\n[Permission refusal truncated.]";
    return `${message.slice(0, MAX_PERMISSION_REFUSAL_CHARACTERS - marker.length)}${marker}`;
}
