import type { GymInferenceRequest } from "@slopus/happy-agent-gym";

const CHANGE_NOTICE = "# Instructions changed\n";
const BLOCK = /<(removed|added)>\n([\s\S]*?)\n<\/\1>/g;

/**
 * The instructions a request leaves in force, read the way the model reads them: the system
 * prompt its history began with, amended in order by every "Instructions changed" notice in the
 * conversation.
 *
 * The prompt stays fixed for the life of a history, so a scenario asking what an agent is told
 * after something changed has to read the notices as well as the prompt.
 */
export function instructionsInForce(request: GymInferenceRequest): string {
    const lines = request.instructions.split("\n");
    for (const message of request.messages) {
        if (message.role !== "system") continue;
        for (const block of message.content) {
            if (block.type !== "text" || !block.text.startsWith(CHANGE_NOTICE)) continue;
            // Text added in place of removed text stands where the removed text stood.
            let position: number | undefined;
            for (const [, kind, body] of block.text.matchAll(BLOCK)) {
                const changed = body!.split("\n");
                if (kind === "removed") {
                    position = undefined;
                    for (const line of changed) {
                        const index = lines.indexOf(line);
                        if (index === -1) continue;
                        lines.splice(index, 1);
                        position ??= index;
                    }
                } else {
                    lines.splice(position ?? lines.length, 0, ...changed);
                    position = undefined;
                }
            }
        }
    }
    return lines.join("\n");
}
