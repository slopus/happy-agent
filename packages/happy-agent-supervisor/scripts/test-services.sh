#!/usr/bin/env bash
# CI-only delegation for real-kernel service tests. Never run this at daemon startup.
set -euo pipefail
service_test_target="${1:?Pass the native target triple or --command followed by a test command}"
shift
if [[ "$service_test_target" == --command ]]; then
    [[ "$#" -gt 0 ]]
else
    [[ "$#" -eq 0 ]]
fi
service_test_original=""
while IFS=: read -r service_test_hierarchy service_test_controllers service_test_path; do
    if [[ "$service_test_hierarchy" == 0 ]]; then
        service_test_original="/sys/fs/cgroup${service_test_path}"
    fi
done < /proc/self/cgroup
[[ "$service_test_original" == /sys/fs/cgroup/* ]]
[[ "$service_test_original" != *..* ]]

service_test_parent="$(sudo mktemp -d /sys/fs/cgroup/happy-service-tests.XXXXXXXX)"
[[ "$service_test_parent" == /sys/fs/cgroup/happy-service-tests.* ]]
service_test_uid="$(id -u)"
service_test_gid="$(id -g)"
service_test_pid="$$"
service_test_cleanup() {
    # Restore only this shell. rmdir refuses any group whose processes have not stopped.
    printf '%s\n' "$service_test_pid" | sudo tee "$service_test_original/cgroup.procs" >/dev/null
    sudo rmdir "$service_test_parent/runner" "$service_test_parent"
}
trap service_test_cleanup EXIT
printf '+memory +pids\n' | sudo tee "$service_test_parent/cgroup.subtree_control" >/dev/null
sudo mkdir "$service_test_parent/runner"
sudo chown "$service_test_uid:$service_test_gid" "$service_test_parent" \
    "$service_test_parent/cgroup.procs" "$service_test_parent/cgroup.threads" \
    "$service_test_parent/cgroup.subtree_control"
printf '%s\n' "$service_test_pid" | sudo tee "$service_test_parent/runner/cgroup.procs" >/dev/null
export HAPPY_SERVICE_TEST_CGROUP_PARENT="$service_test_parent"
if [[ "$service_test_target" == --command ]]; then
    "$@"
else
    cargo test --locked --target "$service_test_target" --test services -- --include-ignored --test-threads=1
fi