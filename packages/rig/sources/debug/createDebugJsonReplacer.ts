import { extractProviderErrorDiagnostics } from "@slopus/rig-providers";

export function createDebugJsonReplacer(): (key: string, value: unknown) => unknown {
    const ancestors: object[] = [];

    return function (this: unknown, _key, value) {
        if (typeof value === "bigint") return `${String(value)}n`;
        if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
        if (typeof value === "symbol") return String(value);
        if (typeof value === "object" && value !== null) {
            while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
            if (ancestors.includes(value)) return "[Circular]";
        }
        if (value instanceof Error) {
            const providerDiagnostics = extractProviderErrorDiagnostics(value, {
                upstreamMessage: value.message,
            });
            const serialized = {
                name: value.name,
                message: value.message,
                ...(value.stack === undefined ? {} : { stack: value.stack }),
                ...(value.cause === undefined ? {} : { cause: value.cause }),
                ...(providerDiagnostics === undefined ? {} : { providerDiagnostics }),
            };
            ancestors.push(value, serialized);
            return serialized;
        }
        if (typeof value !== "object" || value === null) return value;
        ancestors.push(value);
        return value;
    };
}
