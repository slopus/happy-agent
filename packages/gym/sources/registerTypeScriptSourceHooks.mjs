import { existsSync } from "node:fs";
import { registerHooks, setSourceMapsSupport } from "node:module";

// tsx enables dependency maps globally. Parsing large bundled dependency maps
// dominates Windows cold startup; retain source maps for the gym and Happy code.
setSourceMapsSupport(true, { nodeModules: false, generatedCode: false });

const distributionPrefix = "file:///app/packages/happy-terminal/dist/";
const sourcePrefix = "file:///app/packages/happy-terminal/sources/";

registerHooks({
    resolve(specifier, context, nextResolve) {
        const fileSpecifier = specifier.startsWith("/app/packages/happy-terminal/dist/")
            ? new URL(`file://${specifier}`).href
            : specifier;
        if (fileSpecifier.startsWith(distributionPrefix) && fileSpecifier.endsWith(".js")) {
            const sourceUrl = `${sourcePrefix}${fileSpecifier.slice(distributionPrefix.length, -3)}.ts`;
            if (existsSync(new URL(sourceUrl))) return nextResolve(sourceUrl, context);
        }
        if (
            context.parentURL?.startsWith("file:") === true &&
            (specifier.startsWith("./") || specifier.startsWith("../")) &&
            specifier.endsWith(".js")
        ) {
            const sourceUrl = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
            if (existsSync(sourceUrl)) return nextResolve(sourceUrl.href, context);
        }
        return nextResolve(specifier, context);
    },
});
