import { NOT_HANDLED } from "@pydantic/monty";
import { describe, expect, it } from "vitest";

import { createCodeModeOs } from "../../sources/codeMode/engines/monty/MontyOs.js";

describe("CodeModeOs", () => {
    it("provides an empty environment and deterministic local and offset clocks", () => {
        const current = new Date(2026, 7, 29, 12, 34, 56, 789);
        const os = createCodeModeOs(() => current);

        expect(os("os.getenv", ["PATH", null], {})).toBeNull();
        expect(os("os.getenv", ["PATH", "fallback"], {})).toBe("fallback");
        expect(os("os.environ", [], {})).toEqual({});
        expect(os("date.today", [], {})).toEqual({
            __monty_type__: "Date",
            year: 2026,
            month: 8,
            day: 29,
        });
        expect(os("datetime.now", [null], {})).toEqual({
            __monty_type__: "DateTime",
            year: 2026,
            month: 8,
            day: 29,
            hour: 12,
            minute: 34,
            second: 56,
            microsecond: 789_000,
        });
        expect(
            os(
                "datetime.now",
                [{ __monty_type__: "TimeZone", offsetSeconds: 19_800, name: "IST" }],
                {},
            ),
        ).toEqual({
            __monty_type__: "DateTime",
            year: new Date(current.getTime() + 19_800_000).getUTCFullYear(),
            month: new Date(current.getTime() + 19_800_000).getUTCMonth() + 1,
            day: new Date(current.getTime() + 19_800_000).getUTCDate(),
            hour: new Date(current.getTime() + 19_800_000).getUTCHours(),
            minute: new Date(current.getTime() + 19_800_000).getUTCMinutes(),
            second: new Date(current.getTime() + 19_800_000).getUTCSeconds(),
            microsecond: 789_000,
            offsetSeconds: 19_800,
            timezoneName: "IST",
        });
        expect(os("Path.exists", ["/workspace"], {})).toBe(NOT_HANDLED);
    });
});
