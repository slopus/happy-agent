# Kimi Code tool references

These internal `SessionTool` definitions reproduce the ordinary tool descriptors in
[MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code/tree/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/tools),
commit `21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3` (2026-09-30), agent-core-v2 0.4.3.
They are reference assets, carry no execution, and are not exported from the package root.
`kimi_tools` is the explicit subset Bash, Read, Write, Edit, Glob, Grep, and ReadMediaFile;
it is not the full native harness tool array.

Each name comes from its native `*Tool.ts` implementation, each description from its
adjacent Markdown template, and each parameter schema from the corresponding Zod
input declaration. The native `src/tool/input-schema.ts` uses `z.toJSONSchema` with
`target: 'draft-7'` and `io: 'input'`, then closes every object node. These copies
preserve that wire shape with TypeBox, including integer bounds, optional fields,
defaults, descriptions, and nested `additionalProperties: false`. String enums use
`Type.Unsafe` to retain the native `type: 'string', enum: [...]` form instead of
rewriting it as `anyOf` literals.

The copied descriptions are the native rendering for these settings:

- Bash: Linux with shell name `bash`, TaskList/TaskOutput/TaskStop enabled, and the
  default `bashAutoBackgroundOnTimeout: true`. Foreground timeout defaults to 60
  seconds and caps at 300; background defaults to 600 and caps at 86400.
- Read: unconfigured character budgets, 100000 default and 500000 maximum.
- Glob: POSIX paths, without the Windows-only suffix.
- ReadMediaFile: `image_in: true` and `video_in: true`, as declared for managed
  Kimi Code `k3` in the upstream `docs/en/configuration/config-files.md`. Its native
  template specifies the 100 MB file limit and appends the image-and-video
  capability sentence, preserving the template's trailing newline.

Bash's native schema does not express its `superRefine` conditional timeout caps,
the runtime requirement for a nonempty background description, or tool-policy
checks for background task availability. Read's forward-only column offset and
ReadMediaFile's image-only region/full-resolution guards also execute outside the
wire schema. These reference descriptors retain that distinction. Native Read
and ReadMediaFile mention `kimi-file://` session attachments, and Write mentions
the native plan-mode file; those strings are copied without product adaptation.
