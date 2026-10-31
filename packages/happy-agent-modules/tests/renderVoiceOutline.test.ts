import { describe, expect, it } from "vitest";
import {
    renderVoiceOutline,
    VOICE_OUTLINE_BYTES,
} from "../sources/live/impl/renderVoiceOutline.js";

const row = (name: string) => ({ name, agentId: undefined });

describe("the sidebar outline voice is told", () => {
    it("names rows in order without statuses or IDs", () => {
        expect(
            renderVoiceOutline({
                rows: [row("Happy"), row("Release Steward"), row("Garden  notes\nand plans")],
            }),
        ).toBe(
            ["# Sidebar", "", "- Happy", "- Release Steward", "- Garden notes and plans"].join(
                "\n",
            ),
        );
        expect(renderVoiceOutline({ rows: [] })).toBe("# Sidebar");
    });

    it("stays within its budget and counts the rows it leaves out", () => {
        const rows = Array.from({ length: 400 }, (_, index) =>
            row(`A deliberately long conversation name number ${index}`),
        );
        const text = renderVoiceOutline({ rows });
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(VOICE_OUTLINE_BYTES);
        const listed = text.split("\n").filter((line) => line.startsWith("- A deliberately"));
        expect(text.endsWith(`- …and ${400 - listed.length} more entries not listed`)).toBe(true);
    });
});
