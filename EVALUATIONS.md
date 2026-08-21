# Evaluating Happy Agent

This guide defines Happy Agent's small, local agent evaluation. The current suite is a
directional comparison, not a leaderboard result or a statistically powered
claim. It favors hard paired tasks, cost control, and trajectory inspection over
a large aggregate score.

## Current status

The task IDs, comparison arms, prices, and budget rules below were frozen on
2026-07-21. No paid trial has been run.

Paid execution is blocked until every item in [Preflight](#preflight) passes and
the generated Harbor configuration and `lock.json` have been reviewed. Running
a free oracle, image pull, build, local mock, or network canary is preflight;
sending any request to a paid model is not.

Preflight produces `preflight-passed.json` containing the hashes of its evidence
and locked configuration. The trial-token issuer must refuse to mint a token
unless that file validates, so the block is technical as well as procedural.

The initial run compares these four arms:

| Arm | Harness         | Model                  |
| --- | --------------- | ---------------------- |
| A   | Happy Agent     | `openai/gpt-5.6-sol`   |
| B   | stock Codex CLI | `openai/gpt-5.6-sol`   |
| C   | Happy Agent     | `openai/gpt-5.6-terra` |
| D   | stock Codex CLI | `openai/gpt-5.6-terra` |

Every arm receives the same task instruction and task container. The primary
comparisons are A versus B and C versus D. Sol versus Terra is secondary.

## Frozen task manifest

The suite has ten tasks and therefore forty paid invocations: one attempt for
each of four arms. Seven tasks come from the hard tail of SWE-bench Verified;
three exercise terminal workflows that scored below the ceiling in a public
Terminal-Bench 2.0 reference run.

### SWE-bench Verified

Harbor dataset: `swebench-verified@1.0`. Harbor v0.20.0 resolves these tasks
from `laude-institute/harbor-datasets` commit
`86723674f04e4209ac479d0fb75d9d9f44b4377e`.

| Instance                  | Repository          | Verified difficulty |
| ------------------------- | ------------------- | ------------------- |
| `sympy__sympy-13878`      | `sympy/sympy`       | `>4 hours`          |
| `sphinx-doc__sphinx-7590` | `sphinx-doc/sphinx` | `>4 hours`          |
| `pydata__xarray-6992`     | `pydata/xarray`     | `>4 hours`          |
| `django__django-13837`    | `django/django`     | `1-4 hours`         |
| `astropy__astropy-14369`  | `astropy/astropy`   | `1-4 hours`         |
| `pytest-dev__pytest-6197` | `pytest-dev/pytest` | `1-4 hours`         |
| `pylint-dev__pylint-8898` | `pylint-dev/pylint` | `1-4 hours`         |

Verified contains only 45 tasks above one hour: 42 in the `1-4 hours` bucket
and three above four hours. This manifest includes all three of the latter and
spreads the rest over four additional repositories. It avoids the 91% of
Verified labeled at one hour or less, where a tiny frontier-model sample would
be especially prone to ceiling effects.

The four `1-4 hours` anchors were chosen before any requested-arm result for
repository diversity, test breadth, and local feasibility. This is a frozen,
judgmental hard-task panel, not a random or representative sample of Verified.

### Terminal-Bench 2.0

Harbor dataset: `terminal-bench@2.0`. Harbor v0.20.0 resolves these tasks from
`laude-institute/terminal-bench-2` commit
`69671fbaac6d67a7ef0dfec016cc38a64ef7a77c`.

The reference rate is the per-task success frequency from the public stock
Codex 0.121.0 + GPT-5.5 run with five attempts. It is a selection proxy, not a
prediction for the requested models: 20%, 40%, and 60% mean one, two, and three
successes out of five. Selecting on a different stock-Codex run may favor tasks
that stock Codex finds difficult, so this panel must not be presented as an
unbiased estimate over Terminal-Bench 2.0.

| Task              | Reference rate | Agent timeout | CPU / RAM | Reference task hash                                                |
| ----------------- | -------------: | ------------: | --------: | ------------------------------------------------------------------ |
| `db-wal-recovery` |            20% |          900s |  1 / 2 GB | `01f470c86f3a1f7ce4d91bdf0aaaa89fa96a4124ac48617990e2735b5291913a` |
| `gcode-to-text`   |            40% |          900s |  1 / 2 GB | `5531de29b9b445e4cd67b66231d34cb9e7bddcf15f4c2574b7376a19f0e4c339` |
| `dna-assembly`    |            60% |         1800s |  1 / 2 GB | `7bf6f42ea794b180079f40bfae015198142dd763242c16e58e817950aac53e6d` |

All three use small, single-container fixtures with no GPU, Docker socket,
nested Docker, VM, or privileged task requirement. Their published images are
currently `linux/amd64` only, so they run under Docker Desktop emulation on an
Apple-silicon host.

Names and benchmark difficulty labels are not sufficient selectors. Several
tasks that sound difficult, including `cancel-async-tasks`, `fix-ocaml-gc`,
`path-tracing`, and `regex-chess`, scored 100% in the same reference run and are
excluded.

### Replacement rule

A task may be replaced only before any paid result is observed and only for an
objective preflight failure: the gold solution fails, the grader is broken,
the image cannot run safely on this host, or the pinned content is unavailable.
Use the first passing candidate in this fixed order:

1. SWE-bench: `scikit-learn__scikit-learn-25102`, then
   `sympy__sympy-17630`, then `sphinx-doc__sphinx-9461`.
2. Terminal-Bench: `overfull-hbox`.

If the queue cannot preserve seven SWE tasks and three Terminal-Bench tasks,
abort and amend this document before running. Never replace a task because of
an agent's score, cost, or trajectory.

The SWE preflight must also reject the known problematic instances
`astropy__astropy-8872`, `astropy__astropy-7606`,
`astropy__astropy-8707`, `django__django-10097`,
`sphinx-doc__sphinx-8595`, and `sphinx-doc__sphinx-9711`. None is in the frozen
manifest.

## Fairness contract

Freeze these values in the generated job files:

- Harbor `v0.20.0`; do not use an unpinned `main` checkout.
- Happy Agent from a clean worktree at commit
  `e266da4e376fd9770b3ad5d60dfc232c70154c59`.
- stock `codex-cli 0.144.6`.
- exactly one attempt, no model or trial retry, and concurrency one.
- `medium` reasoning effort for all arms. Happy Agent's model defaults and Harbor's
  Codex default differ, so an implicit value is invalid.
- standard API service, never Priority.
- each task's native agent timeout, capped at 30 minutes: 900 seconds for
  `db-wal-recovery` and `gcode-to-text`, and 1800 seconds for `dna-assembly`.
  Record the resolved SWE timeout in the lock. Keep native verifier timeouts.
- stock Codex web search disabled; no skills, MCP servers, personal config, or
  project-external instructions in either arm.
- stock Codex's Harbor adapter must invoke its documented
  `--dangerously-bypass-approvals-and-sandbox` mode inside the task container;
  the adapter smoke test must assert this before comparing it with Happy Agent's Full
  access mode.
- task CPU and RAM limits enforced, a PID limit of 512, no GPU, and at most 10
  GB writable task storage where Harbor supports it.
- identical proxy policy and agent-phase network policy.
- exact task prompts, source commits, task hashes, image digests, arm order,
  prices, and configuration archived before the pilot.

Generate a deterministic, balanced arm order before the pilot and store it in
the manifest. Run complete four-arm blocks per task so a budget stop cannot be
misread as a paired result. The two pilot tasks are
`sphinx-doc__sphinx-7590` and `gcode-to-text`; their eight invocations count in
the final result.

Before starting a block, the controller must reserve its $24 worst-case cost:
two $8 Sol trials and two $4 Terra trials. If less than $24 remains under the
$175 aggregate limit, stop before the block and report only completed blocks.
Release unused reservation when the block finishes.

Do not enable Harbor retries. A setup failure before inference starts may be
fixed during preflight. Once the first paid request for a trial starts, its
outcome is immutable: provider errors, malformed output, timeouts, and harness
failures are classified, not rerun.

## Budget

The total budget is $200. Reserve $175 for planned inference and $25 for local
or transient contingency. The proxy must stop planned model traffic at $175;
using the contingency for additional paid requests requires a newly approved
plan.

OpenAI's standard short-context prices on 2026-07-21 were:

| Model           |   Input | Cached input | Cache write |   Output |
| --------------- | ------: | -----------: | ----------: | -------: |
| `gpt-5.6-sol`   | $5.00/M |      $0.50/M |     $6.25/M | $30.00/M |
| `gpt-5.6-terra` | $2.50/M |      $0.25/M |    $3.125/M | $15.00/M |

For token counts rather than millions:

```text
Sol = input * 5e-6 + cached * 0.5e-6 + cache_write * 6.25e-6
      + output * 30e-6
Terra = input * 2.5e-6 + cached * 0.25e-6 + cache_write * 3.125e-6
        + output * 15e-6
```

Terra is half the Sol price. For `N` shared tasks across two harnesses and two
models, the suite costs approximately `3 * N * average Sol invocation cost`.
For ten tasks, a $5 average Sol invocation projects to $150; the $175 target
requires the average to remain below about $5.83.

Long-context standard rates are higher: Sol is $10.00/M input, $1.00/M cached,
$12.50/M cache write, and $45.00/M output; Terra is exactly half. Set a
conservative 200,000-input-token request ceiling in the proxy. Abort if a call
would cross that ceiling or is billed in the long-context tier; do not silently
change the projection.

The proxy must enforce all of these limits independently of the agents:

- one revocable token per trial, valid for one selected model and the Responses
  API only;
- $8 maximum for a Sol trial and $4 for a Terra trial;
- the 200,000 input-token request ceiling plus explicit request and output-token
  limits;
- a shared $175 aggregate stop and an audit log of token classes and spend;
- expiration immediately after the agent phase, before verification begins.

After the eight pilot invocations, continue only if all preflight invariants
still hold and:

```text
pilot_spend * 5 * 1.25 <= 175
```

Equivalently, the pilot must cost no more than $28.00. If it exceeds that
amount, abort without inspecting scores to alter the task list.

## Harbor runner

Use Harbor for both datasets so container lifecycle, filtering, grading,
timeouts, artifacts, and job identities remain common. Install the exact
release and confirm its registry before generating the job files:

```sh
uv tool install 'harbor==0.20.0'
harbor --version
harbor dataset list
```

The committed/generated configuration is authoritative; avoid ad hoc paid
commands. A stock-Codex command should resolve to the equivalent of:

```sh
harbor run \
  --dataset swebench-verified@1.0 \
  --include-task-name sphinx-doc__sphinx-7590 \
  --agent codex \
  --model openai/gpt-5.6-sol \
  --n-attempts 1 \
  --n-concurrent 1 \
  --max-retries 0 \
  --agent-kwarg version=0.144.6 \
  --agent-kwarg reasoning_effort=medium \
  --agent-kwarg web_search=disabled \
  --cpus limit \
  --memory limit
```

Add the trial token, proxy URL, and proxy-only hostname through the generated
job's agent environment and allowlist. Do not put a real OpenAI key in a task
container. Harbor's stock adapter writes its supplied token to a temporary
Codex auth file that model-generated code can read, which is why a disposable,
model-scoped token is mandatory.

### Happy Agent adapter

Implement `HappyAgent` as a small Harbor `BaseAgent` or `BaseInstalledAgent` and
load it directly with `--agent path.to.agent:HappyAgent`; do not fork Harbor.
The adapter must:

1. Upload a `pnpm pack` artifact built from the pinned clean Happy Agent worktree and
   install it during Harbor's trusted setup phase.
2. Create empty, trial-local `HAPPY_TERMINAL_HOME`, `HAPPY_TERMINAL_CONFIGURATION_DIRECTORY`, and
   `CODEX_HOME` directories. Set `happy_integration = false` and
   `providers.default_enable = false` in the trial-local Happy Agent config, enabling
   only Codex and the selected model. Construct an explicit
   process-environment allowlist containing only ordinary runtime variables and
   the trial's OpenAI proxy values; do not inherit Anthropic, xAI, Moonshot,
   Gemini, AWS, or other provider credentials. Do not copy host sessions,
   credentials, config, skills, or MCP state.
3. Run Happy Terminal against Happy Agent inside the Harbor task container with the exact instruction:

    ```sh
    happy-terminal exec --stream-json \
      --provider codex \
      --model "$MODEL" \
      --effort medium \
      --permission-mode full_access \
      -- "$INSTRUCTION"
    ```

4. Supply only the disposable `OPENAI_API_KEY` and the proxy as
   `HAPPY_TERMINAL_CODEX_BASE_URL`. Full access is acceptable only inside the disposable,
   externally restricted task container and matches stock Codex's benchmark
   posture.
5. Save the complete JSONL stream, stderr, final response, tool calls, wall
   time, exit status, and package identity under Harbor's agent logs. For each
   line where `.type === "event"` and `.event.type === "agent_message"`,
   aggregate `.event.data.message.usage`. Happy Agent currently reports token counts
   there but leaves monetary cost at zero, and `run_finished` has no usage
   rollup.
6. Convert the run to Harbor's trajectory format, or retain enough stable raw
   events for the same audit. Verify that repeated usage records are not double
   counted.
7. Revoke the trial token and terminate agent-created background processes
   before Harbor enables any verifier network access.

Both adapters must pass the same free local fixture against a mock Responses
server before they may receive a paid token.

## Preflight

Complete and record this checklist in order:

1. **Host capacity.** This development Mac is an Apple M5 Max with 128 GB RAM
   and about 1.0 TiB free. Docker Desktop currently exposes only about 8 GB to
   its Linux VM; raise it to at least 16 GB and 8 CPUs. Keep concurrency at one
   and require at least 120 GB free before pulling SWE images. Install Harbor
   v0.20.0, run `harbor run --help`, and cross-check every flag and generated
   job field against the installed CLI before treating the configuration as
   authoritative.
2. **Content lock.** Materialize only the ten selected tasks from the pinned
   Harbor registry, generate `lock.json`, and archive task hashes, git commits,
   task image digests, and the small network-policy overlay. The overlay may
   change setup/agent/verifier networking, but never instructions, fixtures,
   gold patches, or assertions.
3. **Oracle grading.** Run every SWE gold patch and every Terminal-Bench oracle
   through the exact locked grader. All ten must pass on this Mac. Apply the
   replacement rule before any paid request if one does not.
4. **ARM/emulation.** Confirm each amd64 Terminal-Bench image builds, starts,
   runs its oracle, and stays within its native timeout under Docker Desktop
   emulation.
5. **Happy Agent adapter smoke.** Build Happy Agent from the clean pinned worktree, invoke it in
   a disposable Harbor fixture, preserve JSONL and usage, reject interactive
   input, and propagate timeout and nonzero-exit states.
6. **Proxy accounting.** Against a mock upstream, prove the proxy restricts the
   token to one trial, one model, the Responses API, token/request limits,
   per-trial spend, aggregate spend, expiry, and revocation.
7. **Egress canary.** During the agent phase, the task can reach only the proxy.
   Public DNS, a hostname such as `example.com`, a literal public IP, Docker
   metadata, and unrelated host services must fail. Verify that arbitrary DNS
   answers cannot bypass the rule.
8. **Filesystem canary.** The container has no Docker socket, personal home,
   source worktree, SSH agent, cloud credentials, or host path except Harbor's
   dedicated trial log/artifact mounts. Confirm symlinks cannot escape them.
9. **Verifier transition.** Revoke the token and prove no agent-started process
   survives before allowing the verifier to fetch its pinned dependencies. If
   that cannot be proved, prebuild the verifier dependencies and run grading
   with no network.
10. **Dry report.** Generate the final per-task CSV/JSON and paired report from
    oracle and mock artifacts. Review the frozen arm order, projected spend,
    safety evidence, and `git diff` before authorizing the pilot. Write
    `preflight-passed.json` with hashes of the lock, job files, Happy Agent package,
    proxy policy, canary results, oracle results, prices, and review sign-off.
    Confirm the token issuer rejects a missing, stale, or mismatched sign-off.

Do not claim the evaluation is runnable until this checklist passes. If
Harbor's SWE adapter is impractical under ARM emulation, freeze that decision
before observing agent results and use the free `sb-cli` SWE-bench Verified
grader for all four arms. Do not change graders after seeing outcomes.

## Results and audit

Report SWE-bench and Terminal-Bench separately for Sol and Terra. For each
model/benchmark pair include:

- Happy Agent pass count, Codex pass count, paired delta, both pass, Happy Agent only, Codex
  only, and both fail;
- uncached input, cached input, cache-write, and output tokens plus calculated
  spend and wall time;
- valid patch/submission, timeout, provider-error, and infrastructure-failure
  rates.

Classify every non-pass as one of: wrong solution/model failure, empty output,
malformed patch or submission, timeout, interactive-input request, provider
error, tool/runtime/harness failure, or task-image/setup/grader failure. Do not
turn infrastructure failures into model failures, and do not omit them.

Audit every discordant Happy Agent-only or Codex-only task, every infrastructure
failure, several both-fail trajectories, and several both-pass trajectories.
Preserve raw trajectories, predictions, grader logs, proxy accounting, exact
versions, the lock, dirty-state check, and report-generation inputs.

With ten tasks, confidence intervals are wide and exact McNemar tests have low
power. The actual primary denominators are only seven paired SWE tasks and
three paired Terminal-Bench tasks for each model; treat the latter as case
descriptions rather than an estimated benchmark rate.

The primary end-to-end table counts every paid trial that started inference:
reward one is a pass and every other terminal outcome is unresolved, with the
failure class shown explicitly. This captures harness reliability without
calling an infrastructure failure a model error. Also report a capability
sensitivity table that excludes an entire model-specific Happy Agent/Codex task pair if
either arm had an infrastructure failure. Never exclude only the failed arm,
and always print both denominators.

Publish the paired task table and describe mechanisms observed in the traces.
Do not combine both benchmarks into one unexplained percentage or present a
small delta as a general capability claim.

## Method references

This design follows recurring practices in public indie/open agent harnesses:
fixed cheap subsets, separate pass@1 and repeated-attempt results, public
graders, explicit cost/timeout limits, saved trajectories, and per-task paired
comparison.

- [Harbor v0.20.0](https://github.com/harbor-framework/harbor/releases/tag/v0.20.0)
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
- [SWE-bench Verified dataset](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified)
- [OpenAI's SWE-bench Verified audit](https://openai.com/index/introducing-swe-bench-verified/)
- [Terminal-Bench 2.0 stock Codex reference](https://www.tbench.ai/leaderboard/terminal-bench/2.0/codex/0.121.0/gpt-5.5%40openai)
- [Aider benchmark harness](https://github.com/Aider-AI/aider/blob/main/benchmark/README.md)
- [mini-SWE-agent SWE-bench runner](https://github.com/SWE-agent/mini-swe-agent/blob/main/docs/usage/swebench.md)
- [SWE-agent batch evaluation](https://github.com/SWE-agent/SWE-agent/blob/main/docs/usage/batch_mode.md)
- [OpenHands benchmarks](https://github.com/OpenHands/benchmarks)
- [Cline public benchmark artifacts](https://github.com/cline/benchmark-results)
