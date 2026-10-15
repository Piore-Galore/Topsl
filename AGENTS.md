# Topsl — Documentation Working Agreement

This file records the user's documentation habits for work in this repository. Keep `CLAUDE.md` as the single-line pointer `@AGENTS.md`; maintain shared instructions here.

## Keep documentation current with the work

- Update the relevant documentation in the same working cycle as any change to product behavior, architecture, interfaces, persistence, permissions, native integration, configuration, or release workflow. Documentation maintenance is part of completing the task.
- Update engineering instructions when refactors or tooling changes alter how the project is developed, tested, packaged, or operated. Pure internal refactors need no unrelated documentation churn.
- Edit the existing canonical document first. Keep topics focused and link between documents rather than copying large sections or maintaining competing descriptions of the same behavior.
- Keep plans, reviews, and durable validation notes under `docs/`. Add a separate document when it serves a distinct purpose; routine changes should update the relevant existing document.
- Preserve unrelated working-tree changes. Make focused edits and retain existing decisions, evidence, and source attribution.

## Use the existing documentation structure

- [README.md](README.md): user-facing overview, setup, supported flows, commands, and links to detailed documentation.
- [Topsl design](docs/Topsl_Design.md): product intent, architecture, contracts, and agreed design decisions. It describes the target and must identify behavior that remains planned.
- [Implementation status](docs/Implementation_Status.md): current implemented behavior, acceptance evidence, limitations, and remaining gates.
- [Project synchronization](docs/Project_Synchronization.md): detailed native project discovery, synchronization, identity, and compatibility boundaries.
- [Design review](docs/Topsl_Design_Review.md), improvement plans, and phase/evidence documents under `docs/`: review findings, requirements, delivery progress, and reproducible validation records. Link current status to the applicable evidence.
- [Release notes](docs/releases/): version-specific changes and known limitations. Historical releases and dated evidence remain snapshots of what was established at that time.

Update each affected layer when a change crosses these responsibilities. Keep README claims, design decisions, and implementation status consistent without reproducing the full specification in each file.

## Make status and evidence explicit

- Distinguish agreed design, proposed work, implemented behavior, verified behavior, deferred work, unsupported behavior, and retired decisions. An agreed plan or completed specification does not establish runtime implementation.
- Describe current behavior from the actual source and artifacts. Verify paths, commands, configuration keys, versions, and capabilities before documenting them; do not inherit stale implementation claims from older documents or another repository.
- Record consequential decisions with their rationale, constraints, and remaining questions. Identify assumptions and inferences separately from verified facts.
- Keep dated findings and test results tied to their original scope. Add a clearly dated follow-up when new evidence changes the conclusion; do not silently turn an old result into current acceptance.
- For validation, record the commands actually run, meaningful results, relevant environment or revision, evidence locations, and material limitations. Do not invent passing checks or reuse old counts as a fresh result.
- Separate synthetic fixtures, local automated tests, actual Electron UI inspection, native provider acceptance, remote CI, packaged operating systems, and release qualification. Success in one does not establish the others.
- Keep Topsl's native integration boundaries precise: a file write does not prove native reload, registry readback does not prove visible sidebar refresh, and opening an installer does not prove installation.

## Write for the next reader

- Use plain, direct language and descriptive headings. Explain what changed, why it matters, how it was verified, and what remains unresolved.
- Make instructions reproducible with exact commands and real repository paths. Prefer relative Markdown links within repository documentation and primary sources for external technical claims.
- Use concise lists or tables for parallel information, acceptance criteria, and comparisons. Avoid duplicated narratives, speculative completion claims, and progress notes that add no durable information.
- Retain useful provenance and recovery instructions while excluding credentials, private account data, and disposable logs from documentation.

## Verify documentation before finishing

- Review the affected documents for contradictory status, stale instructions, and broken relative links.
- Run `git diff --check` for changed tracked files and check newly created documents for whitespace errors as well.
- For documentation-only changes, check content, links, and diff hygiene; report those checks accurately. Application tests are required only when the change also affects executable behavior or another applicable check requires them.
- A behavior-changing task is incomplete while its relevant documentation still describes the old behavior.
