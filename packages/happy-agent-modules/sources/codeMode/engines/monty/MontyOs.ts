import {
    NOT_HANDLED,
    type MontyDate,
    type MontyDateTime,
    type MontyTimeZone,
    type OsCallback,
} from "@pydantic/monty";
import type { Context } from "@steve.kite/stdlib";

import type { ComputeModule, HostCompute } from "../../../compute/index.js";
import { createCodeModeFileSystem } from "./MontyFileSystem.js";

export interface CodeModeOsFileSystem {
    readonly module: ComputeModule;
    readonly compute: HostCompute;
    readonly ctx: Context;
}

/** The non-side-effecting OS values Code Mode deliberately exposes to Monty. */
export function createCodeModeOs(
    now: () => Date = () => new Date(),
    fileSystem?: CodeModeOsFileSystem,
): OsCallback {
    const files =
        fileSystem === undefined
            ? undefined
            : createCodeModeFileSystem(fileSystem.module, fileSystem.compute, fileSystem.ctx);
    return (name, args, kwargs) => {
        if (name === "os.getenv") return args[1];
        if (name === "os.environ") return {};

        if (name === "date.today") {
            const current = now();
            return {
                __monty_type__: "Date",
                year: current.getFullYear(),
                month: current.getMonth() + 1,
                day: current.getDate(),
            } satisfies MontyDate;
        }
        if (name === "datetime.now") return dateTimeAt(now(), args[0]);
        return files === undefined ? NOT_HANDLED : files(name, args, kwargs);
    };
}

function dateTimeAt(current: Date, timezone: unknown): MontyDateTime {
    if (!isMontyTimeZone(timezone)) {
        return {
            __monty_type__: "DateTime",
            year: current.getFullYear(),
            month: current.getMonth() + 1,
            day: current.getDate(),
            hour: current.getHours(),
            minute: current.getMinutes(),
            second: current.getSeconds(),
            microsecond: current.getMilliseconds() * 1_000,
        };
    }

    const shifted = new Date(current.getTime() + timezone.offsetSeconds * 1_000);
    return {
        __monty_type__: "DateTime",
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
        hour: shifted.getUTCHours(),
        minute: shifted.getUTCMinutes(),
        second: shifted.getUTCSeconds(),
        microsecond: shifted.getUTCMilliseconds() * 1_000,
        offsetSeconds: timezone.offsetSeconds,
        ...(timezone.name === undefined ? {} : { timezoneName: timezone.name }),
    };
}

function isMontyTimeZone(value: unknown): value is MontyTimeZone {
    return (
        typeof value === "object" &&
        value !== null &&
        "__monty_type__" in value &&
        value.__monty_type__ === "TimeZone" &&
        "offsetSeconds" in value &&
        typeof value.offsetSeconds === "number" &&
        (!("name" in value) || value.name === undefined || typeof value.name === "string")
    );
}
