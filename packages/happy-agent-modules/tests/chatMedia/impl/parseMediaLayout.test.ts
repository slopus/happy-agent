import { mediaLayoutSchema } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { parseMediaLayout } from "../../../sources/chatMedia/impl/parseMediaLayout.js";

const FILES = ["out/overview.png", "out/before.png", "out/after.png"];
const PLACE_ALL = '<img src="out/overview.png"><img src="out/before.png"><img src="out/after.png">';

// The HTML subset itself is the client's parser, tested in @slopus/happy-agent-client. These cover
// what present_files adds: images named by filepaths, files appended, and unusable layouts.
describe("parseMediaLayout", () => {
    it("names files by their paths exactly as written and appends the ones left out", () => {
        const result = parseMediaLayout(
            '<figure><img src="out/before.png" style="width: 100%"><figcaption>Before</figcaption></figure>' +
                '<img src="./out/overview.png"><img src="out/before.png">',
            FILES,
        );
        expect(result.layout).toEqual({
            type: "tree",
            root: [
                {
                    type: "element",
                    tag: "figure",
                    children: [
                        { type: "item", index: 1, style: { width: "100%" } },
                        {
                            type: "element",
                            tag: "figcaption",
                            children: [{ type: "text", text: "Before" }],
                        },
                    ],
                },
                { type: "item", index: 0 },
                { type: "item", index: 2 },
            ],
        });
        expect(Value.Check(mediaLayoutSchema, result.layout)).toBe(true);
        expect(result.ignored).toEqual([
            '<img src="./out/overview.png">, which names none of the files',
            'a second <img src="out/before.png">',
        ]);
        expect(result.appended).toEqual(["out/overview.png", "out/after.png"]);
    });

    it("keeps a layout that places no file but holds a widget, appending every file", () => {
        const result = parseMediaLayout(
            '<happy-files><script type="application/json">[{ "path": "src/a.ts", "added": 2 }]</script></happy-files>',
            ["out/overview.png"],
        );
        expect(result.layout).toEqual({
            type: "tree",
            root: [
                { type: "files", files: [{ path: "src/a.ts", added: 2 }] },
                { type: "item", index: 0 },
            ],
        });
        expect(Value.Check(mediaLayoutSchema, result.layout)).toBe(true);
        expect(result.ignored).toEqual([]);
        expect(result.appended).toEqual(["out/overview.png"]);
    });

    it("reports a dropped widget and uses no layout when nothing else resolves", () => {
        const result = parseMediaLayout("<happy-chart>not json</happy-chart>", FILES);
        expect(result.layout).toBeUndefined();
        expect(result.ignored).toEqual([
            "a <happy-chart> whose body is not valid JSON",
            "the whole layout, which placed none of the files",
        ]);
    });

    it("uses no layout when it places none of the files, or is too long", () => {
        const none = parseMediaLayout("<p>Just a caption</p><table></table>", FILES);
        expect(none.layout).toBeUndefined();
        expect(none.ignored).toEqual([
            "<table> (its content is kept)",
            "the whole layout, which placed none of the files",
        ]);
        const long = parseMediaLayout(PLACE_ALL + " ".repeat(32 * 1024), FILES);
        expect(long).toEqual({
            layout: undefined,
            ignored: ["the whole layout, which is longer than 32768 characters"],
            appended: [],
        });
    });
});
