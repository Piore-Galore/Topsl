# Round 2 Phase 3 — Candidate manifests and bounded context

Date: October 15, 2026. This records the local working-tree implementation against baseline `e5e004e31e428d77d2242d3ab472e66d88bb0cc6`. It is not evidence of a delivered commit, remote CI, a qualified live provider, or packaged operating-system acceptance. See the [round execution record](Round_2_Execution.md) and [reviewed specification](Topsl_Round_2_Improvement_Plan_Reviewed.md).

## Implemented artifact contract

New captures use format 2 with a content revision derived from canonical relative paths, SHA-256 bytes, executable bits, file types, and declared manifest/policy semantics. The root, filesystem identity, Git base, author attempt, and workflow remain separately recorded authority/provenance. Equal content can have equal content revisions across roots or projects; this does not transfer workspace trust or blob access.

Format 1 records keep their IDs, hashes, base64 bytes, interpretation, and read paths. They are not silently rewritten or promoted to new verification coverage. Format 2 does not duplicate base64 data in candidate JSON. The [candidate implementation](../packages/workflows/candidates.ts) provides protected full-byte and bounded-range accessors, streamed materialization, current-workspace drift checks, and immutable finding-line validation.

The protected vault advances to schema 6 through the existing encrypted migration/backup procedure. A schema-5 encrypted backup and migration provenance are retained. Newer schemas reject this writer. The encrypted database contains content-addressed 64 KiB chunks with chunk hashes and project/candidate/path references; a hash alone cannot authorize a read. Stored/captured manifests are deeply frozen before cached validation. See [blob storage](../packages/persistence/blobs.ts) and the [schema migration](../packages/persistence/migrations/blobs.ts).

## Capture scope and limits

Git tracking supplies the initial source manifest, including source under `build/` and `release/`. Staged deletions are retained as tombstones, renames are reported using matching content, and executable-bit changes affect content identity. Non-Git folders require an explicit file manifest. Explicit paths can include approved ignored assets without recursively importing unrelated ignored directories.

Credentials, native provider state, dependency caches, and designated generated output stay outside new source captures. Package authentication directives in `.npmrc`, Yarn configuration and provider authentication configuration are rejected even under a reviewed source exception. Non-secret registry configuration can be captured. Flagged source must be reviewed/redacted or capture stops; secret detection remains non-exhaustive. Synthetic source fixtures and separately brokered runtime secrets remain distinct from copying native authentication.

Symlinks, submodules, conflicted index entries, Unicode/case aliases, and unsupported desktop-platform path names stop capture. The opened file is checked before and after reading; final canonical containment, parent components, and handle/target identities are rechecked before publication. These checks narrow filesystem races; portable Node APIs do not establish an `openat`-style filesystem sandbox.

Capture and hashing use bounded chunks and an `AbortSignal`. Limits are configurable through `CandidateSelection.limits`:

| Limit          | Default | Meaning                                         |
| -------------- | ------: | ----------------------------------------------- |
| `fileBytes`    | 128 MiB | Maximum single captured or proposed output file |
| `projectBytes` | 512 MiB | Total captured and proposed-output bytes        |
| `fileCount`    |  20,000 | Captured plus proposed-output paths             |
| `vaultBytes`   |   2 GiB | Published plus temporary encrypted blob bytes   |

The legacy `maxBytes` argument sets file/project capture limits; it is not a prompt limit. Quota errors name the capture boundary. Temporary staging also consumes quota, including when the eventual blob deduplicates. A failed or cancelled capture publishes no candidate manifest, releases its partial references, and discards its current staging. Already published unreferenced bytes can be reclaimed by bounded maintenance.

Capture owner attribution is persisted before staging. Startup recovery processes bounded failed/dead-owner records, leaves live owners alone, and resumes removal of abandoned staging/references. It pages past live or foreign-host captures (bounded scan) so they cannot starve dead ones, and matches staging rows by exact `<captureId>:` prefix (follow-up 2026-10-15, `tests/blob-recovery.test.ts`). Unreferenced published blobs are reclaimed in bounded record batches. Independently retained project candidates remain referenced after conversation deletion; neither conversation deletion nor recovery silently deletes an accepted/project artifact. There is no automatic expiry of retained candidate evidence. Operational cleanup must keep those retention boundaries explicit.

## Immutable scoped reader

The [context server](../packages/workspace/context.ts) exposes these new Topsl contracts through a candidate-aware grant:

| Method                  | Result                                                            |
| ----------------------- | ----------------------------------------------------------------- |
| `candidate-list`        | Bounded permitted file metadata and a scope-bound cursor          |
| `candidate-search`      | Literal text matches, bounded snippets/scan work and continuation |
| `candidate-read-range`  | At most 256 KiB of exact pinned bytes with file/range hashes      |
| `candidate-read-binary` | At most 256 KiB of pinned base64 bytes and explicit review limits |

Every candidate request binds project, workflow, attributed attempt/task/session, candidate ID/revision, grant, path allowlist, and visibility mode. The stored attempt/task/session linkage is checked on each request. Candidate/path filtering occurs before pagination, searching, snippets, or source metadata. Wrong projects/attempts, traversal, withheld peers/paths, expired grants, and revoked grants deny access. Reader content comes from protected references rather than the live root. A UTF-8 range that splits a character is returned as exact base64 with its range hash; lossy replacement text is not described as exact bytes.

[Retrieval receipts](../packages/context/candidate-reader.ts) record the scoped method, returned ranges/hashes, outcome and bytes without tokens, credentials or content. The package separately records complete text initially supplied, optional omissions, and whether retrieval remains required. Initial delivery, later retrieval, and content never delivered remain distinct; none proves comprehension.

## Initial context and dispatch

[Task packages](../packages/context/packages.ts) preserve objective, mandatory acceptance criteria/interfaces, approved shared decisions, findings, candidate identity and review instructions. Optional manifest metadata and complete small-source excerpts fit a separate initial transport budget (128 KiB by default). Larger source stays in the artifact rather than filling the prompt.

The token count is a conservative UTF-8 byte estimate with a 1.2 margin, not a model tokenizer or an invented context window. An explicitly supplied model window/input budget reserves output, tool and runtime tokens, and the smaller usable bound wins. Mandatory overflow blocks preparation before a task/copy/paid turn; criteria are never silently truncated and submission failure never authorizes a duplicate paid retry.

A retrieval-dependent builder/reviewer dispatch requires a context server and an adapter `installCandidateReader` hook. The grant is installed before inference; a missing/failed installer blocks and records failure without submitting a provider turn. A prompt reference or capability declaration does not install a tool. Small fully delivered source packages retain the existing fixture path. No production provider reader qualification is established by these local tests. A materialized review directory remains a separate runtime/isolation acceptance question; copying bytes does not establish independence.

**Follow-up, 16 October 2026.** Only a reviewer's package can now require retrieval. A builder or repair works in the live workspace its candidate was captured from, which matches the candidate when the turn is dispatched, so its package tells it to read omitted files there and it needs no reader. The service now installs the reader for Codex reviewers over Codex's tool channel ([Codex workflows plan, step 3](Codex_Workflows_Plan.md#step-3-candidate-reader-16-october-2026)).

Parallel and advanced workflow contexts now use bounded candidate identity/coverage metadata rather than embedding format-2 file contents. Existing runtime-enforced filesystem/tool isolation gates remain in force.

## Output and binary review

A narrow preapproved creation path permits capture, not automatic execution approval of the resulting new bytes. New additions, staged additions, and proposed untracked outputs carry hashes/status. Required pending/rejected outputs stay visible and block new dispatch/checks/acceptance. Required omitted bytes cannot be approved merely by recording a decision: the allowed path must be recaptured and the resulting manifest reviewed.

For an unexpected proposed output, a separate native-approved `capturePaths` plan names at most fifty new paths and their recorded hashes. It binds the current workflow/candidate revision and is durably consumed before capture starts. Expected hashes are enforced before blob publication; changed bytes fail without applying approval receipts or replaying the spent plan. The service owns the selection amendment. Active/uncertain attempts, workspace leases and checks block recapture. Successful capture retains the old candidate, invalidates old verification, clears current review/acceptance applicability, records revisioned task/scope provenance and explicit supersession, and returns to `ready-review`. The new manifest requires fresh review/checks and a separate output decision where required; the renderer cannot directly widen selection.

The [candidate review approval](../packages/workflows/candidate-reviews.ts) binds native confirmation to the exact candidate/revision/path/hash, digest, expiry and single-use plan. Output receipts use latest-decision semantics: a later rejection revokes an earlier approval. The builder remains at its ready stage awaiting review; approval requires another explicit advance rather than automatic inference. Review and checks resolve the same immutable resulting manifest.

Unchanged binaries remain represented by metadata and do not block text review. Changed binaries carry an explicit manual-verification requirement bound to their candidate/hash. Supported image previews and user-recorded results remain distinct from model understanding or automatic visual verification. Unsupported/large binary formats need an external/manual route; absent that evidence, final acceptance stays blocked. Existing acceptance harnesses continue through the protected check-input contract; added tests cannot silently replace it.

## Local validation and limits

The focused commands run from the repository root are recorded below. Tests execute through the repository's Electron-as-Node test runner. The host is macOS arm64; the command shell reports Node `v26.0.0`.

- `npm run typecheck` — passed after implementation and reader/containment hardening.
- `npm test -- tests/candidate-manifests.test.ts tests/candidate-reviews.test.ts tests/builder-reviewer.test.ts` — 23 passed before the final submodule/executable-bit case was added.
- `npm test -- tests/parallel-workspaces.test.ts tests/builder-reviewer.test.ts tests/advanced-workflows.test.ts tests/context-pagination.test.ts tests/coordination.test.ts` — 54 passed during integration.
- The final focused suite and whitespace/link checks are recorded in the follow-up below.

The manifest cases exercise several megabytes of source, unchanged/changed PNG metadata, Git-tracked build/release source, staged deletion/rename, pending/rejected/new-file hashes, pinned reads after source drift, withheld visibility and live socket expiry, mandatory byte/token overflow, equal content across distinct roots, encryption/deduplication, deterministic interruption, quota failures, dead-owner recovery, legacy schema-5 evidence, package-auth rejection, and an outside hardlink/symlink-parent swap. These are synthetic/local tests. The optional 100 MiB/10,000-file workload, actual UI journey, prepared environment, live providers, remote CI and packaged targets have separate acceptance records; this document does not substitute one for another.

### Follow-up: explicit output recovery and final local checks

The added recovery route was validated with:

- `npm run typecheck` — passed.
- `npm test -- tests/candidate-output-recovery.test.ts tests/candidate-reviews.test.ts tests/candidate-manifests.test.ts tests/builder-reviewer.test.ts` — 4 files, 30 tests passed in 10.12 seconds. The recovery cases reach final acceptance after fresh review/checks, reject changed proposed hashes before publication while consuming the plan, invalidate previous passing verification, and preserve supersession for an unrun check task whose candidate was initially null.
- A later nine-file integration run passed 72 tests and failed three advanced-template acceptance cases at the concurrently strengthened shared lineage gate. That result is retained as a failure, not counted as current advanced-template acceptance; the shared-lineage integration fix and final rerun belong to the round execution record.
- `git diff --check` for affected tracked source/tests — passed. A direct whitespace/final-newline check covered all seven new phase files, and every relative link in this document resolved.

The independent large-capture workload has its own [synthetic stress record](round-2-evidence/r2-6-2026-10-15T04-17-30-880Z-e5ywXu/synthetic-stress.json). Its scope is local capture/retrieval and resource measurement; it does not qualify a live provider or a packaged target.

The final phase-specific rerun after adding grant/request rollout enforcement passed: `npm run typecheck` and the same four-file command above completed with **31 tests passed in 10.63 seconds**. Disabling `manifest-context` now denies new captures, task packages, candidate grants and candidate reader requests, while protected retained bytes and existing history reads remain available. The earlier advanced-template failures remain dated integration evidence; later shared-lineage validation is recorded by the round owner.
