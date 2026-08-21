import { describe, expect, it } from "vitest";

import { parseSessionEnvironmentOptions } from "./parseSessionEnvironmentOptions.js";

describe("parseSessionEnvironmentOptions", () => {
    it("parses an image-backed session and leaves ordinary arguments intact", () => {
        expect(
            parseSessionEnvironmentOptions([
                "exec",
                "--docker-image",
                "project:local",
                "--docker-workdir",
                "/repo",
                "--docker-env",
                "NODE_ENV=test",
                "--docker-mount",
                ".:/repo",
                "--docker-mount",
                "/tmp/cache:/cache:ro",
                "Do the work",
            ]),
        ).toEqual({
            docker: {
                environment: { NODE_ENV: "test" },
                image: "project:local",
                mounts: [
                    { source: ".", target: "/repo" },
                    { source: "/tmp/cache", target: "/cache", readOnly: true },
                ],
                workingDirectory: "/repo",
            },
            remaining: ["exec", "Do the work"],
        });
    });

    it("supports an explicit local override and rejects conflicting selections", () => {
        expect(parseSessionEnvironmentOptions(["--local"])).toEqual({
            docker: null,
            remaining: [],
        });
        expect(() =>
            parseSessionEnvironmentOptions(["--local", "--docker-container", "development"]),
        ).toThrow("Choose one");
    });

    it("extracts request debug logging before interactive and headless commands", () => {
        expect(parseSessionEnvironmentOptions(["--debug"])).toEqual({
            debug: true,
            remaining: [],
        });
        expect(parseSessionEnvironmentOptions(["exec", "--debug", "Inspect this"])).toEqual({
            debug: true,
            remaining: ["exec", "Inspect this"],
        });
        expect(parseSessionEnvironmentOptions(["resume", "--debug", "session-1"])).toEqual({
            debug: true,
            remaining: ["resume", "session-1"],
        });
    });
});
