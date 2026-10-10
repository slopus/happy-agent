import { describe, expect, it } from "vitest";

import { artifactFileRequest } from "../../sources/api/ApiArtifactFiles.js";

const prefix = "/v0/artifacts/r7k2m9q4w1e5/versions";

describe("artifact file request targets", () => {
    it("decodes each segment of a numbered or latest file path", () => {
        expect(artifactFileRequest(`${prefix}/2/files/images/chart%20one.png?x=1`)).toEqual({
            artifactId: "r7k2m9q4w1e5",
            selector: 2,
            path: "images/chart one.png",
        });
        expect(artifactFileRequest(`${prefix}/latest/files/%C3%A9t%C3%A9.md`)).toEqual({
            artifactId: "r7k2m9q4w1e5",
            selector: "latest",
            path: "été.md",
        });
    });

    it("names no file for traversal, encoded separators, empty segments, or bad encoding", () => {
        for (const target of [
            `${prefix}/1/files/css/../index.html`,
            `${prefix}/1/files/css/%2E%2e/index.html`,
            `${prefix}/1/files/./index.html`,
            `${prefix}/1/files/css%2Fsite.css`,
            `${prefix}/1/files/css//site.css`,
            `${prefix}/1/files/css/`,
            `${prefix}/1/files/bad%E0.md`,
            `${prefix}/1/files/back%5Cslash.md`,
            `${prefix}/1/files/line%0Abreak.md`,
            `${prefix}/0/files/index.md`,
            `${prefix}/99999999999999999999/files/index.md`,
            `${prefix}/1/files/`,
            undefined,
        ]) {
            expect({ target, request: artifactFileRequest(target) }).toEqual({
                target,
                request: undefined,
            });
        }
    });
});
