# Phase 2 — builder/reviewer coordination

Date: 14 October 2026. This records implemented local behavior and actual fixture evidence. It does not certify live provider execution or packaged platform support.

## Implemented path

Activity contains a Build and review form. The user captures one objective, explicit acceptance criteria, reversible provider assignments, requested models, file coverage and required check commands. Start evaluates both selected runtime capability reports before dispatching either provider. Completed turns advance through candidate capture, a fresh reviewer session, at most two repairs, required checks, and explicit native acceptance.

The provider-neutral engine is `packages/workflows/builder-reviewer.ts`. The service routes are `builder-reviewer-create`, `builder-reviewer-query`, `builder-reviewer-inspect`, `builder-reviewer-advance`, `builder-reviewer-checks-preview`, `builder-reviewer-check-apply`, `builder-reviewer-accept`, and `builder-reviewer-cancel`. Request receipts prevent a repeated command identity from redispatching. An uncertain external outcome is blocked rather than automatically retried.

`packages/context/packages.ts` stores exact immutable prompts, specification/source revisions, omission records, instruction hashes and explicitly estimated sizes. Mandatory context overflow blocks dispatch. Per-attempt context grants deny unrelated project history and are revoked separately; their context tool route is not silently enabled. Submission and provider acknowledgment have separate receipts, and neither proves comprehension or confirmed instruction loading.

`packages/workflows/candidates.ts` captures approved tracked files and explicitly selected untracked outputs, exact bytes, modes, hashes, Git basis and instruction hashes in encrypted SQLite. Known excluded paths are recorded. Non-Git folders require an explicit manifest. Credentials, ignored files, provider state, caches and build output are excluded. Unsupported binary review, symlinks, conflicts and submodules are gated. Source identity, manifest and bytes are checked again before review, checks and acceptance.

Review runs in a materialized pinned snapshot with a fresh session. Findings name their candidate revision, behavior and evidence. A persisted snapshot proof validates the exact review file set after completion; a missing, changed or previously failed proof permanently blocks that workflow's review. Repairs retain historical tasks through explicit supersession records. Final acceptance follows verified replacement chains, rather than treating arbitrary cancellation as successful work.

`packages/workflows/verification.ts` executes the user-reviewed absolute executable and exact arguments against a temporary materialization of the candidate. It records the target revision, environment, exit result and protected output. It does not install dependencies or borrow untracked live checkout files. Captured-file mutation and source drift invalidate the result. Shell wrappers are refused. Check plans are consumed transactionally once; failed, missing or stale checks prevent acceptance. OS filesystem and network sandboxing are not established by this check executor.

Independent filesystem/tool isolation is not established. The independent template is refused; ordinary candidate review displays “Independence not enforced.” Native terminal operation remains available under its existing ownership boundaries.

## Claude route and current gate

`packages/providers/claude.ts` implements the shared adapter contract, a bounded versioned NDJSON reader, fixture subprocess transport, interrupt/session/event/usage normalization and a default production gate. The parser rejects mixed sessions, event identity collisions, malformed records, missing final results and unbounded native subagent events. It excludes thinking blocks and arbitrary tool arguments from persisted telemetry. Partial and final messages share the native message identity, so streamed review JSON is not duplicated.

Read-only inspection on this host found `/opt/homebrew/bin/claude`, version `2.1.183`. Its help exposed print/stream-json, explicit models/sessions, safe mode, tool controls, setting-source and strict MCP controls. Sanitized `auth status --json` reported logged in, `oauth_token`, `firstParty`; no credential or account value was retained. No model request was submitted. Production capability reports use the selected installation's version/revision; this host observation is not hardcoded as a capability for another runtime.

Current official documentation describes the [CLI print and stream routes](https://code.claude.com/docs/en/cli-reference), [programmatic execution and bare-mode authentication](https://code.claude.com/docs/en/headless), [Agent SDK product authentication limits](https://code.claude.com/docs/en/agent-sdk/overview), and [credential/product-use boundaries](https://code.claude.com/docs/en/legal-and-compliance). CLI flag availability does not verify permission isolation or product billing eligibility. Bare mode does not load native OAuth credentials; this implementation introduces no API-key fallback. The selected profile lacks approved live protocol, billing and permission acceptance, so live Claude coordination refuses before process creation. Default managed Codex capabilities also remain classified according to the current capability inventory rather than inheriting fixture enforcement.

## Recorded validation

- `npm test -- tests/claude-provider.test.ts tests/candidates-context.test.ts`: 9 tests passed.
- `npm test -- tests/builder-reviewer.test.ts tests/claude-provider.test.ts tests/candidates-context.test.ts`: 19 tests passed.
- `npm test -- tests/workflow-service.test.ts tests/claude-provider.test.ts`: 9 tests passed, including both Codex-build/Claude-review and Claude-build/Codex-review through Service, RuntimeManager and actual local RPC/NDJSON fixture subprocesses.
- `npm run typecheck`: passed after Phase 2 service and Activity integration.
- Final combined Phase 2 suites: `npm test -- tests/workflow-service.test.ts tests/builder-reviewer.test.ts tests/claude-provider.test.ts tests/candidates-context.test.ts` passed 22 tests before the added accepted-candidate observation regression; final typecheck also passed.
- `npm test -- tests/builder-reviewer.test.ts`: 11 tests passed after adding accepted-candidate refresh invalidation; typecheck passed again afterward.

The lifecycle fixtures exercise fresh session identities, immutable context, requested/effective model separation, real snapshot checks, explicit acceptance, one repair with attributable supersession, the two-repair bound, unknown dispatch without replay, stale source acceptance rejection, failed checks, changed/missing review proof across repeated advance and restart, mandatory context overflow without orphan review tasks, and exclusion of unapproved live workspace files. Service tests also verify duplicate request receipts and rejection of check/acceptance calls without native approval evidence. Fixture provider injection exists only on the isolated local test constructor, with no renderer activation command.

The final combined test run and cross-phase checks are recorded by the integration pass. Bounded live-provider acceptance, subscriptions/billing eligibility for the selected runtime, enforceable independence, dependency provisioning, packaged OS/runtime combinations and full responsive/accessibility UI acceptance remain separate gates. No provider installation/update, credential/configuration-store change, paid request, commit, push or release occurred during this phase. Existing packaging edits were preserved.
