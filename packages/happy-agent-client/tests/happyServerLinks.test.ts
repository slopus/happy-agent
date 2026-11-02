import { describe, expect, it } from "vitest";

import { parseHappyUrl } from "../sources/happyLinks.js";
import { formatHappyServerLink, parseHappyServerLink } from "../sources/happyServerLinks.js";

const INSTANCE = "k3x9q2m7p0a4b8c1d5e6f7g2";
const LINK = `happy://${INSTANCE}/server?url=https%3A%2F%2Fhappy.acme.example%2F`;

describe("server links", () => {
    it("formats and parses a server's identity and base URL", () => {
        expect(
            formatHappyServerLink({ instanceId: INSTANCE, url: "https://happy.acme.example/" }),
        ).toBe(LINK);
        expect(parseHappyServerLink(LINK)).toEqual({
            instanceId: INSTANCE,
            url: "https://happy.acme.example/",
        });
    });

    it("keeps a path prefix and a port", () => {
        const server = { instanceId: INSTANCE, url: "https://edge.acme.example:8443/happy/team/" };
        const link = formatHappyServerLink(server);
        expect(link).toBe(
            `happy://${INSTANCE}/server?url=https%3A%2F%2Fedge.acme.example%3A8443%2Fhappy%2Fteam%2F`,
        );
        expect(parseHappyServerLink(link)).toEqual(server);
    });

    it("accepts any valid escape, including lowercase hex", () => {
        expect(
            parseHappyServerLink(
                `happy://${INSTANCE}/server?url=https%3a%2f%2fhappy.acme.example%2f`,
            ),
        ).toEqual({ instanceId: INSTANCE, url: "https://happy.acme.example/" });
    });

    it("refuses anything that is not exactly a server link", () => {
        const encode = (url: string) => `happy://${INSTANCE}/server?url=${encodeURIComponent(url)}`;
        for (const link of [
            encode("http://happy.acme.example/"),
            encode("http://localhost:3000/"),
            encode("https://Happy.Acme.Example/"),
            encode("https://happy.acme.example:443/"),
            encode("https://happy.acme.example"),
            encode("https://happy.acme.example/team"),
            encode("https://user@happy.acme.example/"),
            encode("https://happy.acme.example/?token=1"),
            encode("https://happy.acme.example/#x"),
            `${LINK}&token=1`,
            `${LINK}#x`,
            `happy://${INSTANCE}/server/?url=https%3A%2F%2Fhappy.acme.example%2F`,
            `happy://${INSTANCE}/server?url=https%3A%2F%2Fhappy.acme.example%2`,
            `happy://${INSTANCE}/server?url=%E0%A4%A`,
            `happy://${INSTANCE}/server?url=`,
            `happy://K3x9q2m7p0a4b8c1d5e6f7g2/server?url=https%3A%2F%2Fhappy.acme.example%2F`,
            `happy://${INSTANCE}/server?url=https://happy.acme.example/`,
            `happy://${INSTANCE}/server?url=${"a".repeat(4096)}`,
        ]) {
            expect(parseHappyServerLink(link), link).toBeUndefined();
        }
    });

    it("is not a Happy link", () => {
        expect(parseHappyUrl(LINK)).toBeUndefined();
    });

    it("refuses to format a link a phone could not use", () => {
        for (const server of [
            { instanceId: INSTANCE, url: "http://localhost:3000/" },
            { instanceId: INSTANCE, url: "https://happy.acme.example" },
            { instanceId: "not-an-instance", url: "https://happy.acme.example/" },
        ]) {
            expect(() => formatHappyServerLink(server)).toThrow(TypeError);
        }
    });
});
