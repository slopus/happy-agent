import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { inspectGymImage } from "./inspectGymImage.js";

const execFileAsync = promisify(execFile);
const builds = new Map<string, Promise<string>>();

export function buildGymImage(image: string, repositoryRoot: string): Promise<string> {
    let build = builds.get(image);
    if (build === undefined) {
        const buildImage = () =>
            execFileAsync(
                "docker",
                [
                    "build",
                    "--quiet",
                    "--file",
                    "packages/gym/Dockerfile",
                    "--tag",
                    image,
                    repositoryRoot,
                ],
                { cwd: repositoryRoot, maxBuffer: 100 * 1024 * 1024 },
            ).then(({ stdout }) => stdout.trim());
        const pending =
            process.env.HAPPY_TERMINAL_GYM_REBUILD === "1"
                ? buildImage()
                : inspectGymImage(image, repositoryRoot).catch((error: unknown) => {
                      if (process.env.HAPPY_TERMINAL_GYM_SKIP_BUILD === "1") {
                          throw error;
                      }
                      return buildImage();
                  });
        build = pending.catch((error: unknown) => {
            if (builds.get(image) === build) builds.delete(image);
            throw error;
        });
        builds.set(image, build);
    }
    return build;
}
