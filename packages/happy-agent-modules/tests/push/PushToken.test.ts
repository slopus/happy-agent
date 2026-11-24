import { inspect } from "node:util";

import { expect, it } from "vitest";

import { PushToken } from "../../sources/push/PushToken.js";

const TEXT = "HappyPushToken[aB3dE6gH9jK2mN5pQ8sT1v]";

it("keeps the capability out of every way a value is printed", () => {
    const token = PushToken.parse(TEXT)!;

    expect(token.expose()).toBe(TEXT);
    expect(String(token)).toBe("HappyPushToken[redacted]");
    expect(`${token}`).toBe("HappyPushToken[redacted]");
    expect(JSON.stringify({ token })).toBe('{"token":"HappyPushToken[redacted]"}');
    expect(inspect({ token }, { depth: 5 })).toBe("{ token: HappyPushToken[redacted] }");
});

it.each([
    ["an Expo token", "ExponentPushToken[aB3dE6gH9jK2mN5pQ8sT1v]"],
    ["21 characters", "HappyPushToken[aB3dE6gH9jK2mN5pQ8sT1]"],
    ["23 characters", "HappyPushToken[aB3dE6gH9jK2mN5pQ8sT1vX]"],
    ["punctuation", "HappyPushToken[aB3dE6gH9jK2mN5pQ8sT1-]"],
    ["a non-ASCII letter", "HappyPushToken[aB3dE6gH9jK2mN5pQ8sT1é]"],
    ["leading text", ` ${TEXT}`],
    ["trailing text", `${TEXT}\n`],
    ["a number", 42],
    ["nothing", undefined],
])("refuses %s", (_name, value) => {
    expect(PushToken.parse(value)).toBeUndefined();
});
