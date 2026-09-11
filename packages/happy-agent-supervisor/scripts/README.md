# Packaging scripts

`package.mjs` follows the native npm layout used by Rig Code Mode: platform
packages carry one binary and checksum, while the root package carries the
TypeScript API and optional dependencies selecting all four variants.

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
