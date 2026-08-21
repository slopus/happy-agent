# Skills module

```ts
const skills = new SkillsModule(computeModule);
```

`SkillsModule` takes the compute module and asks it for the exact cached compute belonging to the
current agent, and for the permissions that machine is read under. It recursively discovers user
skills under `~/.agents/skills` and project skills under `.agents/skills` from the nearest Git root
down to `compute.cwd`. A deeper project skill with the same name replaces an earlier one. There are
no other roots: a skill is a file on the agent's own machine, so an agent with no machine has no
skills and is given no skill tools.

The catalog and skill documents are read live through `compute.fs`, bounded, and exposed through
model instructions plus `list_skills` and `read_skill`. Both tools read inside Happy Agent's own filesystem
boundary, so neither is reviewed in Auto. The module owns no database and no persistent index.
Discovery skips dot-directories, `node_modules`, and malformed or unreadable skills without hiding
the rest of the catalog; `list_skills` uses its returned cursor to continue a bounded page.
Frontmatter metadata is parsed as YAML-compatible mapping data, including flow maps, aliases,
quoted values, and block scalars.

## Public operations

- `list(ctx, agentId, input?)` — a bounded, optionally filtered page of the current catalog.
- `read(ctx, agentId, { name })` — the complete document for one currently discoverable skill.
