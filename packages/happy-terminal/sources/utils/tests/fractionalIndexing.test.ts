import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";

import { BASE_52_DIGITS, generateKeyBetween, generateNKeysBetween } from "../fractionalIndexing.js";

describe("generateKeyBetween", () => {
    it.each([
        [null, null, "a0"],
        [null, "a0", "Zz"],
        [null, "Zz", "Zy"],
        ["a0", null, "a1"],
        ["a1", null, "a2"],
        ["a0", "a1", "a0V"],
        ["a1", "a2", "a1V"],
        ["a0V", "a1", "a0l"],
        ["Zz", "a0", "ZzV"],
        ["Zz", "a1", "a0"],
        [null, "Y00", "Xzzz"],
        ["bzz", null, "c000"],
        ["a0", "a0V", "a0G"],
        ["a0", "a0G", "a08"],
        ["b125", "b129", "b127"],
        ["a0", "a1V", "a1"],
        ["Zz", "a01", "a0"],
        [null, "a0V", "a0"],
        [null, "b999", "b99"],
        [null, "A000000000000000000000000001", "A000000000000000000000000000V"],
        ["zzzzzzzzzzzzzzzzzzzzzzzzzzy", null, "zzzzzzzzzzzzzzzzzzzzzzzzzzz"],
        ["zzzzzzzzzzzzzzzzzzzzzzzzzzz", null, "zzzzzzzzzzzzzzzzzzzzzzzzzzzV"],
        ["a1", "a0", "a0V"],
    ] as const)("generates a key between %s and %s", (a, b, expected) => {
        expect(generateKeyBetween(a, b)).toBe(expected);
    });

    it.each([
        [null, "A00000000000000000000000000", "invalid order key"],
        ["a00", null, "invalid order key"],
        ["a00", "a1", "invalid order key"],
        ["0", "1", "invalid order key head"],
    ] as const)("rejects invalid key bounds", (a, b, message) => {
        expect(() => generateKeyBetween(a, b)).toThrow(message);
    });
});

describe("generateNKeysBetween", () => {
    it.each([
        [null, null, 5, "50 51 52 53 54"],
        ["54", null, 10, "55 56 57 58 59 600 601 602 603 604"],
        [null, "50", 5, "45 46 47 48 49"],
        [
            "50",
            "52",
            20,
            "501 502 503 5035 504 505 506 507 508 509 51 511 512 513 514 515 516 517 518 519",
        ],
    ] as const)("supports a custom digit alphabet", (a, b, count, expected) => {
        expect(generateNKeysBetween(a, b, count, "0123456789").join(" ")).toBe(expected);
    });

    it.each([
        ["01", null, null, 8, "10 11 111 1111 11111 111111 1111111 11111111"],
        ["01", "10", null, 1, "11"],
        ["01", "10", "11", 1, "101"],
        ["¡¢£¤¥¦", null, null, 6, "¤¡ ¤¢ ¤£ ¤¤ ¤¥ ¤¦"],
        [" !#$%&", null, null, 6, "$  $! $# $$ $% $&"],
    ] as const)("supports self-headed alphabets", (digits, a, b, count, expected) => {
        expect(generateNKeysBetween(a, b, count, digits).join(" ")).toBe(expected);
    });

    it("supports a separate integer-head alphabet", () => {
        expect(generateKeyBetween("a0", "a1", "0123456789", "ABab")).toBe("a05");
        expect(generateKeyBetween("a9", null, "0123456789", "ABab")).toBe("b00");
        expect(generateKeyBetween(null, "B9", "0123456789", "ABab")).toBe("B8");
        expect(() => generateKeyBetween("c00", null, "0123456789", "ABab")).toThrow(
            "invalid order key head",
        );
    });

    it.each([
        ["a00", "a01", "a00P"],
        ["a0/", "a00", "a0/P"],
        [null, null, "a "],
        ["a ", null, "a!"],
        [null, "a ", "Z~"],
        [null, "A                          0", "A                          ("],
        ["a~", null, "b  "],
        ["Z~", null, "a "],
        ["a0", "a0V", "a0;"],
        ["a  1", "a  2", "a  1P"],
    ] as const)("supports a base-95 fractional alphabet", (a, b, expected) => {
        const digits =
            " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
        expect(generateKeyBetween(a, b, digits, BASE_52_DIGITS)).toBe(expected);
    });

    it("rejects trailing base-95 zeroes", () => {
        const digits =
            " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
        expect(() => generateKeyBetween("a0 ", "a0!", digits, BASE_52_DIGITS)).toThrow(
            "invalid order key",
        );
        expect(() => generateKeyBetween("b   ", null, digits, BASE_52_DIGITS)).toThrow(
            "invalid order key",
        );
        expect(() =>
            generateKeyBetween(null, "A                          ", digits, BASE_52_DIGITS),
        ).toThrow("invalid order key");
    });

    it("uses the custom digit alphabet as the default head alphabet", () => {
        let seed = 1;
        const random = (): number =>
            (seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff;
        const keys: string[] = [];
        for (let iteration = 0; iteration < 2_000; iteration += 1) {
            const position = Math.floor(random() * (keys.length + 1));
            const lower = position > 0 ? keys[position - 1]! : null;
            const upper = position < keys.length ? keys[position]! : null;
            const defaultHead = generateKeyBetween(lower, upper, "0123456789");
            expect(generateKeyBetween(lower, upper, "0123456789", "0123456789")).toBe(defaultHead);
            keys.splice(position, 0, defaultHead);
        }
    });

    it.each([
        [
            "0213456789",
            "ABab",
            "digits must be at least 2 characters in strictly ascending character code order",
        ],
        [
            "0",
            "ABab",
            "digits must be at least 2 characters in strictly ascending character code order",
        ],
        [
            "0123456789",
            "abc",
            "intDigits must be an even number of at least 2 characters in strictly ascending character code order",
        ],
        [
            "0123456789",
            "ba",
            "intDigits must be an even number of at least 2 characters in strictly ascending character code order",
        ],
        ["0123456789", "ΑΒΓΔ", "intDigits must be single-byte"],
    ] as const)("validates digit alphabets", (digits, intDigits, message) => {
        expect(() => generateKeyBetween(null, null, digits, intDigits)).toThrow(message);
    });

    it("rejects multi-byte fractional alphabets", () => {
        expect(() => generateNKeysBetween(null, null, 10, "ΑΒΓΔΕΖΗΘ")).toThrow(
            "digits must be single-byte",
        );
    });

    it("generates keys in lexicographic order under randomized insertion", () => {
        for (const [digits, intDigits] of [
            ["0123456789", undefined],
            [" !#$%&", undefined],
            ["¡¢£¤¥¦", undefined],
            ["0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", undefined],
            ["01", BASE_52_DIGITS],
            ["0123456789", "0123456789"],
        ] as const) {
            let seed = 1;
            const random = (): number =>
                (seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff;
            const keys: string[] = [];
            for (let iteration = 0; iteration < 1_000; iteration += 1) {
                const position = Math.floor(random() * (keys.length + 1));
                const lower = position > 0 ? keys[position - 1]! : null;
                const upper = position < keys.length ? keys[position]! : null;
                const key = generateKeyBetween(lower, upper, digits, intDigits);
                expect(lower === null || lower < key).toBe(true);
                expect(upper === null || key < upper).toBe(true);
                keys.splice(position, 0, key);
            }
            expect([...keys].sort()).toEqual(keys);
        }
    });

    it("sorts identically in JavaScript and SQLite BINARY collation", async () => {
        let seed = 7;
        const random = (): number =>
            (seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff;
        const keys: string[] = [];
        for (let iteration = 0; iteration < 5_000; iteration += 1) {
            const position = Math.floor(random() * (keys.length + 1));
            const key = generateKeyBetween(
                position === 0 ? null : keys[position - 1]!,
                position === keys.length ? null : keys[position]!,
            );
            keys.splice(position, 0, key);
        }

        const database = createClient({ intMode: "number", url: "file::memory:" });
        try {
            await database.execute(
                "CREATE TABLE ordered_keys (order_key TEXT NOT NULL COLLATE BINARY)",
            );
            await database.batch(
                [...keys].reverse().map((key) => ({
                    args: [key],
                    sql: "INSERT INTO ordered_keys (order_key) VALUES (?)",
                })),
                "write",
            );
            const sqliteKeys = (
                await database.execute(
                    "SELECT order_key FROM ordered_keys ORDER BY order_key COLLATE BINARY",
                )
            ).rows.map((row) => row.order_key);
            expect(sqliteKeys).toEqual([...keys].sort());
        } finally {
            await database.close();
        }
    });
});
