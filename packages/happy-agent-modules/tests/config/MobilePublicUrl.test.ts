import { describe, expect, it } from "vitest";
import { normalizePublicApiUrl } from "../../sources/config/PublicApiConfig.js";

describe("public phone origins", () => {
    it.each([
        [" Agent.Example.COM ", "https://agent.example.com"],
        ["HTTPS://Agent.Example.COM:443/", "https://agent.example.com"],
        ["agent.example.com:8443", "https://agent.example.com:8443"],
        ["https://bücher.example", "https://xn--bcher-kva.example"],
        ["https://[::1]:8443/", "https://[::1]:8443"],
    ])("normalizes %s", (input, output) => expect(normalizePublicApiUrl(input)).toBe(output));

    it.each([
        "",
        " ",
        "http://agent.example",
        "wss://agent.example",
        "https://user:pass@agent.example",
        "https://@agent.example",
        "https://agent.example/path",
        "https://agent.example/../",
        "https://agent.example?",
        "https://agent.example#",
        "https://agent.example:0",
        "https://agent.example:65536",
        "https://a b.example",
        "https://agent.example\\evil",
        "https://agent.example\nother",
        "https://agent.example\u0000",
        "https://agent.example\u007f",
        "a".repeat(2049),
    ])("rejects invalid origin %s", (input) =>
        expect(() => normalizePublicApiUrl(input)).toThrow("HTTPS origin"),
    );
});
