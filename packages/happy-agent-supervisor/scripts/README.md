# Packaging scripts

`test-services.sh <rust-target>` is a CI-only, privileged resource-delegation fixture. It creates
one temporary cgroup, moves only its test shell into a leaf, and runs the real native service
isolation tests with the memory/pids controllers enabled. It restores that shell and removes
empty test groups afterward. It never changes daemon startup or production service settings.
The Linux supervisor publication gate runs it explicitly; missing delegation cannot silently
skip these security checks during publication.

`allow-published-test-namespaces.sh` permits namespace setup only at the installed native
artifact's exact host path on disposable hosted Linux CI. `test-container-namespaces.sh`, after
building the compute fixture image, first proves that the same artifact fails closed at its
read-only container mount path. It then installs a named, explicitly selected test-container
profile and proves startup succeeds. Both retain Ubuntu's global AppArmor user-namespace restriction;
neither script is part of daemon startup or changes a developer's machine.

`package.mjs` follows the native npm layout used by Rig Code Mode: platform
packages carry one binary and checksum, while the root package carries the
TypeScript API and optional dependencies selecting all five variants. Windows
also includes the matching Happy runner and setup helper, plus their licenses.

`test-apparmor.sh /absolute/path/to/happy-agent-supervisor` runs the real binary inside Ubuntu's
existing `unprivileged_userns` profile. It verifies that startup fails closed with an actionable
AppArmor diagnostic before the workload runs. It loads no policy and changes no sysctls. Run it
on Ubuntu 24.04 with `aa-exec` installed, separately from the native success-path suite.

Native Windows checks require the existing Happy provisioning directory in
`HAPPY_WINDOWS_SANDBOX_HOME`; they do not install accounts or firewall rules.
`verify-native-windows-output.mjs` sends 65,536 unbuffered four-byte writes
through the real supervisor with a deliberately slow consumer. It verifies exact
stdout/stderr bytes and hashes, including the tail before process completion.
The transport uses bounded queues with backpressure; output-transfer failures
must return a nonzero exit rather than present incomplete output as success.
The same verifier also checks restricted ConPTY stdin roundtrips and preservation of a nonzero child exit code.

`verify-native-windows-stability.mjs` alternates 66 real read-only and workspace-write
commands. It verifies write denials on protected paths and outside the workspace,
then compares the permanent ACLs and capability registry against their warmed
baseline. Command scratch directories must not grow either persistent structure.
