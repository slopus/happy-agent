# Packaging scripts

`package.mjs` follows the native npm layout used by Rig Code Mode: platform
packages carry one binary and checksum, while the root package carries the
TypeScript API and optional dependencies selecting all four variants.

`test-apparmor.sh /absolute/path/to/happy-agent-supervisor` runs the real binary inside Ubuntu's
existing `unprivileged_userns` profile. It verifies that startup fails closed with an actionable
AppArmor diagnostic before the workload runs. It loads no policy and changes no sysctls. Run it
on Ubuntu 24.04 with `aa-exec` installed, separately from the native success-path suite.
