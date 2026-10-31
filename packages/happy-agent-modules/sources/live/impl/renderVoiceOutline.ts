import type { VoiceOutline } from "./VoiceOutline.js";

/** The outline fits GPT-Live's startup budget; omitted entries are named as a count. */
export const VOICE_OUTLINE_BYTES = 8192;
export const VOICE_OUTLINE_TITLE = "Sidebar";

/**
 * The person's sidebar as names only, the way voice talks about it: no status, activity, messages,
 * or IDs.
 */
export function renderVoiceOutline(outline: VoiceOutline): string {
    const lines = outline.rows.map((row) => `- ${oneLine(row.name)}`);
    const header = `# ${VOICE_OUTLINE_TITLE}\n`;
    const kept: string[] = [];
    let bytes = Buffer.byteLength(header);
    for (const [index, line] of lines.entries()) {
        const rest = lines.length - index;
        const marker = `\n- …and ${rest} more ${rest === 1 ? "entry" : "entries"} not listed`;
        if (
            bytes + Buffer.byteLength(`${line}\n`) + Buffer.byteLength(marker) >
            VOICE_OUTLINE_BYTES
        ) {
            kept.push(marker.trimStart());
            break;
        }
        kept.push(line);
        bytes += Buffer.byteLength(`${line}\n`);
    }
    return `${header}${kept.length === 0 ? "" : `\n${kept.join("\n")}`}`.trimEnd();
}

function oneLine(text: string): string {
    return text.replace(/\s+/g, " ").trim().slice(0, 256) || "Untitled";
}
