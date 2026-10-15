# Round 2 Phase 4 — prepared verification environments

Implemented in the existing working tree on 15 October 2026. This document records source behavior and local offline process fixtures. It does not qualify a live provider workflow, remote CI target, packaged operating system, or delivered commit. See [baseline](Round_2_Baseline.md), [durable execution](Round_2_Phase_1.md), and [current implementation status](Implementation_Status.md).

## Reviewed recipe and shared execution path

Builder/reviewer, parallel, and advanced workflows use the same `previewCheck` → `CheckExecutions` path. Every new check plan contains an immutable version 1 `EnvironmentRecipe`, and its dispatch transaction records the environment instance before materialization or preparation effects. Existing verification/check plans without recipes retain historical environment coverage unknown; they are not backfilled into qualified prepared results. The service-owned `prepared-verification` gate can disable new prepared checks without granting trust, approval, or isolation.

`environment-detect {projectId}` reads bounded package metadata from a trusted project and offers self-contained and locked JavaScript/TypeScript suggestions. These are untrusted repository suggestions, not execution authorization. No script, executable, version command, or npm CLI is executed during detection or preview. Exact executable/file identities are read and hashed. Native executable wrappers such as Windows `.cmd`/`.bat` remain unsupported; Node invokes the npm `bin/npm-cli.js` directly. Windows npm wrapper discovery can locate that JavaScript entry point without invoking the wrapper.

A stored environment selection can be supplied as `requiredChecks[].environmentRecipeId` (or the corresponding parallel/advanced check definition). The native check approval shows exact command arguments, candidate revision, recipe, package scripts, hooks, writable outputs, network limits, bounded execution policy, and expiry. Renderer package-script selection becomes a native Node invocation with an argument array; the renderer never evaluates a package-script string as shell input. npm may execute the exact reviewed package script after approval. Original scripts and harness inputs remain frozen by the existing check-input binding; supplemental tests cannot replace them. A substituted external npm CLI fails that binding.

The recipe binds host identity, platform/architecture, exact check/Node/npm identities, the npm installation's support-file identity, package/lockfile and local archive hashes, lifecycle policy, explicit non-secret environment values, writable output paths, preparation/version commands and timeouts, resource policy, and network disclosures. Full support/dependency hashing streams content and has 100,000-entry, 1 GiB-total and 128 MiB-per-file budgets. Node/npm versions are unobserved in preview and observed only by approved preparation probes, retained on the environment instance. The service Node version is labelled separately from the selected check runtime.

## Supported preparation and permissions

| Choice | Implemented behavior and boundary |
|---|---|
| Self-contained | Fresh disposable candidate copy; no dependency installation. |
| Locked JavaScript/TypeScript, offline default | npm lockfile v2/v3, fresh `npm ci --offline --ignore-scripts --no-audit --no-fund --cache {cache}`. Candidate-local integrity-bound archives work without a registry. A registry cache miss fails preparation. |
| Locked JavaScript/TypeScript, explicit registry preparation | A distinct reviewed recipe removes `--offline`. Package fetching happens only after native approval and durable dispatch intent. It has no enforceable registry allowlist. This route has preview coverage but was not used for any network install during this phase. |
| Reviewed hooks | Default deny required lifecycle hooks declared by the lockfile/root manifest. An exception names an exact locked package, native executable, argument array, and timeout. npm still uses `--ignore-scripts`; only those explicit commands run afterward. Installed package version/identity is checked against its locked entry. |
| User-approved local | Local OS privileges; filesystem/network access and CPU/memory limits are not enforced. Process group/tree observation has the [Phase 1 limitations](Round_2_Phase_1.md). |
| Strong isolation or enforceable network allowlist required | Unsupported; no execution. Approval cannot supply a missing restriction. |

No live `node_modules`, developer cache, shared mutable dependency tree, or authenticated native configuration is copied. Every execution allocates a fresh npm cache, disposable home/config paths, task temp directory, database path and reserved loopback port, all outside the candidate copy. The loopback reservation is explicitly handed off; binding errors must be handled by the test. A port handoff is not a guarantee against another local process winning the bind. Private registry secret grants, workspace/link dependency recipes, additional package managers/languages, immutable shared-cache reuse, OS sandboxes, and external database/service orchestration are not implemented or advertised.

Check processes use a separate environment builder, not the provider's native environment. They do not inherit provider credential variables, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, SSH agent sockets, proxy variables, `NODE_OPTIONS`, native credential homes, or native npm user/global config paths. Explicit values deny credential/runtime/resource override keys and recognizable secrets. This is credential-environment hygiene, not an OS access boundary: a user-approved local process has the user's underlying filesystem privileges. No provider authentication or billing route is altered.

Canonical candidate bytes and protected original harnesses remain in the encrypted store outside the mutable execution tree. Preparation and verification compare original source/harness files and execution additions, and the prepared dependency tree receives a separate identity. Only reviewed output paths may be added; they cannot overlap original captured inputs or harness directories. Unexpected files, removed/changed source/harness inputs, or persistent dependency mutation invalidate evidence even after exit code zero. These are boundary integrity checks. A local process can mutate and restore files between observations; runtime immutability is not claimed.

## Durable lifecycle and authorization

Environment instances carry planned, approved, preparing, ready, failed, cancelled or uncertain state. Preparation logs are separate from check output, bounded to 500,000 bytes/256 records with 16,000-byte lines and explicit truncation, and redact recognizable credentials across partial stream chunks. Failures include policy, preparation, timeout, cancellation and integrity categories. A failed installation is an environment error; a nonzero actual test after ready preparation is a candidate check failure. Cleanup remains independent of both.

Every preparation command records a durable dispatch intent and command index and resets current lifecycle evidence to null before spawning. The new PID/process snapshot is saved immediately after spawn. Earlier commands' quiescent evidence is historical and cannot release a later unobserved command. A restart marks interrupted preparation uncertain and never replays preparation or checks. The dispatch-to-PID evidence gap remains unreconcilable automatically. Late preparation observation/log callbacks are fenced after finalization or bounded uncertainty. Cleanup waits for the applicable process evidence. Reconciliation cannot manufacture a pass.

An immutable `check-authorization-definition` is separate from mutable use accounting and revocation. Default permission is one use/ten minutes. Explicit policy may allow at most ten uses and a bounded expiry (up to one hour). Optional candidate changes apply only inside the same workflow with unchanged harness/definition/environment policy. Each use atomically consumes one allowance alongside a fresh execution intent and binds the exact current candidate, original workspace authority, current workflow specification revision and current tester/integration task. A repaired builder/reviewer workflow obtains its new check task rather than attributing new evidence to an old tester. `check-authorization-reuse-preview` produces a new plan; dependency/toolchain/permission drift requires fresh approval. Exhaustion, expiry, revocation, active/uncertain ownership or cancellation blocks dispatch. A reused allowance does not skip native confirmation in the desktop flow; a one-time approval activating automatic future reruns has not been implemented.

Environment selections, recipes, instances, per-command intents/outcomes, protected logs, authorization definitions and consumptions are version 1 encrypted documents under the existing schema 6 protected store. They use its consistent encrypted migrations/backup and older-writer fence. Existing candidates, old verification records and consumed single-use plans remain intact. No separate cleartext environment database or credential record is introduced.

The additive service APIs are:

- `environment-detect`, `environment-selection-create`, `environment-instances-query`, and `environment-instance-inspect`.
- `check-authorization-reuse-preview` and `check-authorization-revoke`.
- Existing check preview/apply/inspect and cleanup/reconciliation commands. Check inspection includes the environment recipe, instance and protected preparation logs.

## Local acceptance evidence

Commands run from `/Users/piore/repos/Topsl` with existing dependencies:

```sh
npm run typecheck
npm test -- tests/environments.test.ts tests/durable-executions.test.ts tests/protected-check-inputs.test.ts tests/builder-reviewer.test.ts
```

The targeted run completed with 52 passing tests across these four files; the preceding integrated TypeScript check passed. Further full-suite, clean-export and platform qualification belong to the Round 2 qualification cycle. Earlier failed fixture runs exposed a canonical `/var` versus `/private/var` comparison, a registry-miss fixture still selecting a local dependency, and an assertion expecting two preparation commands after version probes were introduced. Those were corrected; no provider request or registry download was used to repair them.

| Acceptance | Local fixture coverage |
|---|---|
| R2-AT-25 | Real fresh npm installation from a self-created integrity-bound local archive; actual package-script check; poisoned host dependencies excluded; provider credential environment excluded. Separate registry recipe has read-only preview coverage and zero dispatch. |
| R2-AT-26 | Offline missing registry/cache, required hook denial, exact reviewed hook, preparation timeout/cancellation, redacted bounded preparation logs, and a ready environment with a genuinely failing candidate test. |
| R2-AT-27 | Lockfile identity changes, dependency mutation, changed toolchain, substituted npm CLI, no preview effects from a sentinel CLI. Fresh caches are never reused as verified. |
| R2-AT-28 | Persistent source and original-harness mutation invalidate zero exit; originals remain outside the copy. Reviewed build output is allowed; unapproved shadow scripts fail. |
| R2-AT-29 | Concurrent executions have separate temp/database paths, reserved port identities, homes, caches and output trees; cleanup follows quiescence. A recorded later-command dispatch-gap snapshot cannot reconcile a previous quiescent command. Database paths are disposable file fixtures, not external database acceptance. |
| R2-AT-30 | Bounded reruns create new exact-candidate executions; exhaustion, expiry, revocation and dependency-policy drift fail; required isolation/allowlists and rollout disablement prevent dispatch. |

These local fixtures establish the recorded implementation boundaries. Actual Electron journey inspection, live provider execution, online registry preparation, private authentication, external services, physical disk exhaustion, crash-process injection, Windows/Linux/Intel Mac execution, independent release artifacts and committed clean-export qualification remain separate gates. The later-command restart test restores a captured durable dispatch-gap snapshot; it does not claim an actual operating-system crash was injected.
