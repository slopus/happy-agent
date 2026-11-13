import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateGenUiDocument } from "../../../sources/impl/genUi/validateGenUiDocument.js";

const examples = fileURLToPath(new URL("../../../../../docs/genui/examples", import.meta.url));

/** The errors for a document, which must be invalid. */
function errorsOf(document: unknown): readonly string[] {
    const validation = validateGenUiDocument(
        typeof document === "string" ? document : JSON.stringify(document),
    );
    if (validation.ok) throw new Error("Expected the document to be invalid.");
    return validation.errors;
}

/** A valid card with one stat, to break one rule at a time. */
function card(root: Record<string, unknown> = {}) {
    return {
        genui: 1,
        fallback: "Revenue was $1.24M.",
        root: {
            type: "card",
            title: "Q3",
            children: [{ type: "stat", label: "Revenue", value: "$1.24M" }],
            ...root,
        },
    };
}

const button = (label: string) => ({
    type: "button",
    label,
    action: { type: "message", text: label },
});

describe("the Gen UI validator", () => {
    const files = readdirSync(examples).filter((name) => name.endsWith(".genui.json"));

    it("has every example of the spec to check", () => {
        expect(files.length).toBeGreaterThanOrEqual(14);
    });

    it.each(files)("accepts the example %s", (name) => {
        const validation = validateGenUiDocument(readFileSync(join(examples, name), "utf8"));
        expect(validation.ok ? [] : validation.errors).toEqual([]);
    });

    it("accepts a small card", () => {
        expect(validateGenUiDocument(JSON.stringify(card())).ok).toBe(true);
    });

    it("names the node path and prop of every wrong prop", () => {
        expect(
            errorsOf(
                card({
                    title: 3,
                    color: "red",
                    badge: { text: "Live", tone: "magenta" },
                    children: [{ type: "stat", label: "Revenue", value: 8412 }],
                }),
            ),
        ).toEqual([
            "root<card>.color: unknown property",
            "root<card>.title: expected string",
            'root<card>.badge.tone: "magenta" is not one of neutral, accent, success, warning, danger, red, orange, yellow, green, teal, cyan, blue, indigo, purple, pink, brown, gray',
            "root<card>.children[0]<stat>.value: expected string",
        ]);
    });

    it("takes a colour name wherever a tone goes, and only colour names for a series", () => {
        expect(
            validateGenUiDocument(
                JSON.stringify(
                    card({
                        badge: { text: "Desktop", tone: "blue" },
                        children: [
                            { type: "callout", text: "Tinted", tone: "teal" },
                            {
                                type: "chart",
                                kind: "bar",
                                labels: ["a"],
                                series: [{ name: "s", values: [1], color: "brown" }],
                            },
                        ],
                    }),
                ),
            ).ok,
        ).toBe(true);
        expect(
            errorsOf(
                card({
                    children: [
                        {
                            type: "chart",
                            kind: "bar",
                            labels: ["a"],
                            series: [{ name: "s", values: [1], color: "danger" }],
                        },
                    ],
                }),
            ),
        ).toEqual([
            'root<card>.children[0]<chart>.series[0].color: "danger" is not one of red, orange, yellow, green, teal, cyan, blue, indigo, purple, pink, brown, gray',
        ]);
    });

    it("explains an action by the variant its type names", () => {
        expect(
            errorsOf(
                card({
                    actions: [{ type: "button", label: "Open", action: { type: "open" } }],
                }),
            ),
        ).toEqual(["root<card>.actions[0]<button>.action.url: required"]);
    });

    it("refuses a secret action that carries a value or asks for no variables", () => {
        const secret = (prefill: Record<string, unknown>) =>
            card({
                actions: [
                    {
                        type: "button",
                        label: "Add key",
                        action: { type: "secret", secret: prefill },
                    },
                ],
            });
        expect(
            errorsOf(secret({ variables: [{ name: "STRIPE_SECRET_KEY", value: "sk_test_1" }] })),
        ).toEqual([
            "root<card>.actions[0]<button>.action.secret.variables[0].value: unknown property",
        ]);
        expect(errorsOf(secret({ id: "stripe", variables: [] }))).toEqual([
            "root<card>.actions[0]<button>.action.secret.variables: 0 items, allowed 1..64",
        ]);
    });

    it("refuses unknown types, children where none are taken, and non-node children", () => {
        expect(
            errorsOf(
                card({
                    children: [
                        { type: "text", text: "Hi", children: [] },
                        { type: "pill" },
                        "Lost",
                        { type: "stack", children: [{ type: "text" }] },
                    ],
                }),
            ),
        ).toEqual([
            "root<card>.children[0]<text>: text takes no children",
            'root<card>.children[1]: unknown type "pill"',
            "root<card>.children[2]: expected a node object",
            "root<card>.children[3]<stack>.children[0]<text>.text: required",
        ]);
    });

    it("holds actions to buttons, at most three, and only on a card", () => {
        expect(
            errorsOf(
                card({
                    actions: [button("a"), button("b"), button("c"), { type: "text", text: "d" }],
                    children: [{ type: "stack", actions: [button("e")] }],
                }),
            ),
        ).toEqual([
            "root<card>.children[0]<stack>.actions: unknown property",
            "root<card>.actions: at most 3",
            "root<card>.actions[3]<text>: must be one of button",
        ]);
    });

    it("holds ids to their pattern and to one use each", () => {
        expect(
            errorsOf(
                card({
                    id: "q3",
                    children: [
                        { type: "text", id: "q3", text: "Again" },
                        { type: "text", id: "bad id", text: "Spaced" },
                    ],
                }),
            ),
        ).toEqual([
            'root<card>.children[0]<text>.id: "q3" is used twice',
            "root<card>.children[1]<text>.id: must be 1–64 letters, digits, _ or -",
        ]);
    });

    it("holds the document to its version, root, and limits", () => {
        expect(errorsOf({ ...card(), genui: 2, extra: true })).toEqual([
            "extra: unknown property",
            "genui: expected 1",
        ]);
        expect(errorsOf({ genui: 1 })).toEqual(["root: required"]);
        let deep: Record<string, unknown> = { type: "text", text: "Deep" };
        for (let level = 0; level < 6; level += 1) deep = { type: "stack", children: [deep] };
        expect(errorsOf({ genui: 1, root: deep })).toEqual([
            `root${"<stack>.children[0]".repeat(6)}<text>: nested deeper than 6`,
        ]);
        const many = Array.from({ length: 200 }, () => ({ type: "text", text: "x" }));
        expect(errorsOf({ genui: 1, root: { type: "stack", children: many } })).toEqual([
            "document: more than 200 nodes",
        ]);
        expect(
            errorsOf(`{"genui":1,"root":{"type":"text","text":"${"x".repeat(262_144)}"}}`),
        ).toEqual(["document: larger than 262144 bytes"]);
        expect(errorsOf("{")[0]).toMatch(/^document: not JSON/);
        expect(errorsOf([])).toEqual(["document: expected object"]);
    });
});
