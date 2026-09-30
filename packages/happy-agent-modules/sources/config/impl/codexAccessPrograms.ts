import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { CodexProvider, type CodexProviderOptions } from "@slopus/happy-providers";

export const codexAccessProgramSchema = Type.Union([
    Type.Literal("standard"),
    Type.Literal("daybreak_blue"),
    Type.Literal("daybreak_red"),
]);

type CodexAccessProgram = Static<typeof codexAccessProgramSchema>;
const programsSchema = Type.Array(codexAccessProgramSchema);
const selectedProgramSchema = Type.Object({ cyberAccessProgram: codexAccessProgramSchema });

/** The published SDK must implement a configured mode before Happy offers its routes. */
export function supportsCodexAccessProgram(program: CodexAccessProgram): boolean {
    const supported = Reflect.get(CodexProvider, "cyberAccessPrograms");
    return Value.Check(programsSchema, supported) && supported.includes(program);
}

export function createConfiguredCodexProvider(
    options: CodexProviderOptions,
    program: CodexAccessProgram | undefined,
): CodexProvider {
    const unavailable = (): Error =>
        new Error(
            `Codex access program "${program}" requires a published happy-providers SDK with access-program support. Update all SDK dependency pins after that release.`,
        );
    if (program !== undefined && !supportsCodexAccessProgram(program)) throw unavailable();
    if (program !== undefined && options.credential.name !== "codex-session")
        throw new Error("Codex access programs require a ChatGPT Codex session credential.");
    const provider = new CodexProvider({
        ...options,
        ...(program === undefined ? {} : { cyberAccessProgram: program }),
    });
    if (
        program !== undefined &&
        (!Value.Check(selectedProgramSchema, provider) || provider.cyberAccessProgram !== program)
    )
        throw unavailable();
    return provider;
}
