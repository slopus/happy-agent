import type { AgentModule } from "@slopus/happy-agent-base";

import { BUILTIN_SKILLS, type BuiltinSkill } from "./impl/builtinSkills.js";

/**
 * The skills Happy Agent ships, for every agent that has a machine.
 *
 * They live in the package, not on the agent's machine, so discovery takes them from here rather
 * than walking for them: a container or remote compute has no copy of Happy Agent's files, and the
 * bundled binary has none at all. The skills module adds them below every filesystem skill.
 */
export class BuiltinSkillsModule implements AgentModule {
    readonly name = "builtin-skills";

    /** Every shipped skill, with its complete document. */
    list(): readonly BuiltinSkill[] {
        return BUILTIN_SKILLS;
    }

    /** The document of the shipped skill at this location, or nothing for any other location. */
    read(location: string): string | undefined {
        return BUILTIN_SKILLS.find((skill) => skill.entry.location === location)?.content;
    }
}
