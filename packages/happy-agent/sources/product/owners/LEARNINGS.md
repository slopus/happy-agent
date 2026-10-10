# Native durable owner learnings

Node identity belongs to the installation, including when no conversation agents exist. Preserve
the original transactional singleton and its complete avatar asset. Name changes commit their
Durable Functions intent with the state, and the executor reads the current stored name instead
of replaying a name captured in arguments. Config owns the serialized atomic runtime file write.

Global skill disablement keeps the skill installed, readable and watched. The catalog retains its
identity and enablement across disappearance and reappearance. Preferences are written from the
current committed catalog; watcher execution belongs to Durable Functions and releases every
native watch on cancellation or module close.

Frontmatter needs a real YAML parser: line-prefix parsing misses aliases, flow maps, block scalars
and quoted boolean values. Native parsing uses YAML syntax and the original TypeBox metadata
schemas. Its mapping visitor retains the shipped rule that the last string or boolean scalar
wins when top-level keys repeat; only an actual boolean `true` reserves model invocation.

Runners own agent computes after a filesystem reader returns. A bounded strong catalog holds
them until confirmed disposal, while computes keep a weak reference to their owning module to
avoid a cycle. An unconfirmed disposal remains in Closing and cannot execute new work. Report
deduplication follows the runner epoch across reconnects; lease expiry finishes owned sessions
even without another connection. Command requests check their generation after obtaining a
bounded channel slot and again on reply, so a lost handle cannot act on a reused remote ID.

Directory aliases have separate installation identities and enablement preferences. Discovery
excludes a canonical skill document only when no present, enabled, ready alias still exposes it.
Disabling one alias must not hide a second enabled installation of the same directory.

Missing generated schemas must fail owner construction before recovery starts. Native owners
resolve every required runtime schema up front, so an omitted event validator cannot turn owed
work into an executor failure that deletes its pending call and state.
