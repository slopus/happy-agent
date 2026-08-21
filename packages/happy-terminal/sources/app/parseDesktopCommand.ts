import { HappyTerminalUserError } from "../HappyTerminalUserError.js";
import type { RunDesktopOptions } from "./runDesktop.js";

export function parseDesktopCommand(arguments_: readonly string[]): RunDesktopOptions {
    let buildOnly = false;
    let forceBuild = false;
    let happy2Root: string | undefined;
    let skipBuild = false;

    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index]!;
        if (argument === "--build-only") {
            buildOnly = true;
            continue;
        }
        if (argument === "--force-build") {
            forceBuild = true;
            continue;
        }
        if (argument === "--skip-build") {
            skipBuild = true;
            continue;
        }
        if (argument === "--happy2-root") {
            happy2Root = arguments_[index + 1];
            if (!happy2Root) {
                throw new HappyTerminalUserError("The --happy2-root option needs a directory.", {
                    hint: "Usage: happy-terminal desktop --happy2-root /path/to/happy2",
                });
            }
            index += 1;
            continue;
        }
        if (argument.startsWith("--happy2-root=")) {
            happy2Root = argument.slice("--happy2-root=".length);
            if (!happy2Root) {
                throw new HappyTerminalUserError("The --happy2-root option needs a directory.", {
                    hint: "Usage: happy-terminal desktop --happy2-root /path/to/happy2",
                });
            }
            continue;
        }
        throw new HappyTerminalUserError(`Unknown happy-terminal desktop option '${argument}'.`, {
            hint: "Usage: happy-terminal desktop [--build-only] [--skip-build | --force-build] [--happy2-root PATH]",
        });
    }

    if (skipBuild && forceBuild) {
        throw new HappyTerminalUserError(
            "Happy Terminal cannot skip and force the desktop build at the same time.",
            {
                hint: "Use either --skip-build or --force-build.",
            },
        );
    }

    return {
        buildOnly,
        forceBuild,
        ...(happy2Root === undefined ? {} : { happy2Root }),
        skipBuild,
    };
}
