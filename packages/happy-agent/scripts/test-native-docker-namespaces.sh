#!/usr/bin/env bash
# Disposable hosted CI only. Preserve Source's explicit test-container allowance
# and prove its default refusal before selecting that named profile.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]
[[ "$(uname -s)" == Linux ]]
[[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" == 1 ]]
native_container_binary="$(realpath "${1:?Pass the built whole Happy Agent executable}")"
[[ "$native_container_binary" == "$GITHUB_WORKSPACE/target/debug/happy-agent" ]]
[[ -f "$native_container_binary" && -x "$native_container_binary" ]]

probe_container() {
    docker run --rm --network none \
        --security-opt seccomp=unconfined --security-opt "apparmor=${1:-unconfined}" \
        --security-opt systempaths=unconfined \
        --mount "type=bind,source=$native_container_binary,target=/opt/happy-agent/compute,readonly" \
        --entrypoint /opt/happy-agent/compute ubuntu:24.04 supervisor \
        --policy '{"mode":"full_access","network":{"egress":true,"localBinding":true}}' \
        -- /bin/sh -c 'printf ready'
}

set +e
native_container_output="$(probe_container 2>&1)"
native_container_status=$?
set -e
if [[ "$native_container_status" != 125 || "$native_container_output" != *AppArmor* || "$native_container_output" == *ready* ]]; then
    printf 'Expected the default container-path AppArmor denial; exit=%s output=%s\n' "$native_container_status" "$native_container_output" >&2
    exit 1
fi
printf 'Confirmed default container-path namespace refusal: %s\n' "$native_container_output"

# Docker selects this profile only for the isolated live fixture. It neither
# changes the product default nor grants namespaces to unrelated executables.
sudo tee /etc/apparmor.d/happy-compute-container-tests >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>
profile happy-compute-container-tests flags=(unconfined) {
    userns,
}
EOF
sudo apparmor_parser --replace /etc/apparmor.d/happy-compute-container-tests
if ! native_container_output="$(probe_container happy-compute-container-tests 2>&1)"; then
    printf 'The selected Source test profile did not admit the whole executable: %s\n' "$native_container_output" >&2
    exit 1
fi
[[ "$native_container_output" == ready ]]
[[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" == 1 ]]
printf 'The same whole executable starts with the selected Source live-test profile.\n'