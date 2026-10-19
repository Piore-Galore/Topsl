# Test coverage register — campaign 2026-10-19-comprehensive

Generated from every packet's `results.jsonl` by `test-results/agent-testing/2026-10-19-comprehensive/aggregate.py` and `render_coverage.py`, after applying the independent review's reclassifications (`p9-review/overrides.jsonl`). Raw rows, notes, test citations and commands are in `coverage.json` beside those scripts; that directory is local evidence and is not tracked. Read the [campaign report](TEST-REPORT.md) for scope and conclusions, and the [decisions register](TEST-DECISIONS.md) for every defect.

## How to read this register

- One row per plan case. **Layer results** lists each executed or planned layer instance on the only available host, `darwin-arm64` (macOS 27.0.1, Apple M5). U = pure contract, S = service and store, P = real subprocess and transport, E = Electron journey, N0 = native runtime without a model turn, N1 = authenticated provider turns, K = packaged app, L = load or soak.

- **Other hosts** counts rows that packets wrote for darwin-x64, win32-x64 and linux-x64. Every such cell is BLOCKED (no host) or NOT APPLICABLE (for example, Codex qualification refuses Windows by design). Any cell not listed is NOT RUN.

- **Case result** is the worst local layer result in the order FAIL, PASS, NOT IMPLEMENTED, BLOCKED, SKIPPED, NOT RUN, NOT APPLICABLE. A PASS case therefore means at least one local layer passed and none failed. It does **not** mean every layer, variation or platform passed: look at the layer list.

- A PASS from one packet outranks a NOT RUN placeholder from another for the same cell; a FAIL is never hidden by a PASS.

## Summary

| Case result (darwin-arm64) | Cases |
| --- | ---: |
| FAIL | 27 |
| PASS | 287 |
| BLOCKED | 9 |
| NOT RUN | 36 |
| **Total** | **359** |

| Layer | PASS | FAIL | NOT IMPLEMENTED | BLOCKED | NOT RUN | NOT APPLICABLE |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| U | 86 | 7 | 0 | 0 | 37 | 0 |
| S | 204 | 18 | 1 | 0 | 49 | 2 |
| P | 103 | 3 | 0 | 0 | 80 | 0 |
| E | 26 | 0 | 0 | 6 | 223 | 0 |
| N0 | 2 | 0 | 0 | 0 | 40 | 0 |
| N1 | 5 | 2 | 1 | 67 | 52 | 1 |
| K | 15 | 1 | 0 | 10 | 76 | 0 |
| L | 1 | 0 | 0 | 0 | 14 | 0 |

**Commands:** all 197 public commands (162 general, 19 coordinator, 16 loop) are mapped through the plan's 60 command groups below. 197 belong to a group with at least one PASS case, and 70 to a group with at least one FAIL case. The source schemas match the plan's Appendix A exactly (no added, removed or renamed commands).

## 5.1 Startup, vault, storage, and migration

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| DATA-01 | P0 | Start with a new profile under a secure OS key store; initialize once, close, reopen, and recover the same his… | PASS | E BLOCKED; K PASS; S PASS |
| DATA-02 | P0 | Secure storage absent, locked, or Linux `basic_text`: use the supported passphrase path or show an actionable … | PASS | E BLOCKED; K BLOCKED; S PASS |
| DATA-03 | P0 | New passphrase of 11 versus 12 characters, Unicode passphrases, cancellation and wrong passphrase: enforce the… | PASS | E BLOCKED; U PASS |
| DATA-04 | P0 | Missing vault with existing database, malformed envelope, invalid authentication tag, unknown vault format, or… | **FAIL** | K PASS; S **FAIL** |
| DATA-05 | P0 | Write identifiable canaries to messages, search indexes, candidates, configuration backups and WAL; inspect st… | PASS | S PASS |
| DATA-06 | P0 | Migrate each retained supported historical schema with realistic records; verify counts, immutable identities,… | PASS | S PASS |
| DATA-07 | P0 | Fault during migration or transaction commit, including full disk and failed rename: reopen to a consistent ol… | PASS | S PASS |
| DATA-08 | P0 | Open a newer schema with an older writer; reject safely and retain data. Test upgrade from a real earlier pilo… | PASS | K PASS; S PASS |
| DATA-09 | P0 | Crash while staging protected blobs, before manifest publication, and after reference creation: incomplete cap… | PASS | S PASS |
| DATA-10 | P1 | Encrypted closed-profile backup and manual restore with database plus vault; verify search, team overrides, lo… | not run | L not run; S not run |
| DATA-11 | P1 | Large database, abrupt service death, WAL recovery, repeated open/close and corrupted blob chunk: retain valid… | PASS | L not run; S PASS |
| DATA-12 | P0 | Immutable records reject rewritten content under the same identity; duplicate commands either return the origi… | PASS | S PASS |

## 5.2 Application discovery, acquisition, installation, and updates

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| APP-01 | P1 | Discover no provider, CLI only, desktop only, both providers, bundled CLI, duplicate aliases and multiple chan… | BLOCKED | E BLOCKED; K BLOCKED; S not run |
| APP-02 | P0 | Locate a runtime manually; reject missing, wrong-kind, unsupported wrapper or changed executable. Trust binds … | not run | E not run; S not run |
| APP-03 | P1 | Startup/manual/periodic metadata and executable checks obey due times, per-installation backoff and independen… | PASS | S PASS |
| APP-04 | P0 | Artifact selection covers OS/architecture/channel and publisher allowlist; reject wrong architecture, unapprov… | PASS | P PASS; U PASS |
| APP-05 | P0 | Download-only success exposes the verified complete artifact and never installs it. Cancellation, partial down… | PASS | E not run; P PASS |
| APP-06 | P1 | Retry acquisition creates a fresh reviewed operation and starts from byte zero as currently designed; progress… | PASS | E not run; P PASS |
| APP-07 | P0 | Modify a lifecycle preview, installation revision or approval digest; double-submit, expire after 15 minutes, … | PASS | E not run; S PASS |
| APP-08 | P0 | Active native session or unknown process inventory defers an approved update. Expiry continues while queued, a… | PASS | P not run; S PASS |
| APP-09 | P0 | Concurrent jobs for the same installation/management unit produce one owner; different eligible installations … | PASS | P not run; S PASS |
| APP-10 | P0 | Homebrew operation targets the exact cask/channel with auto-refresh disabled; bundled Codex updates through it… | PASS | K BLOCKED; S PASS |
| APP-11 | P0 | Native installer/store/update handoff is recorded as pending. Only rediscovery of the intended installation/ve… | BLOCKED | E not run; K BLOCKED |
| APP-12 | P0 | Crash before dispatch, after dispatch, during native installer work and before readback; retain uncertainty, b… | PASS | K BLOCKED; S PASS |
| APP-13 | P1 | Native update flow closes with unchanged version versus still running/unknown: report unchanged only when clos… | PASS | K BLOCKED; S PASS |
| APP-14 | P1 | Fresh install/update under denied elevation, publisher rejection, disk exhaustion, locked files and native can… | BLOCKED | K BLOCKED |
| APP-15 | P1 | Installation succeeds but provider protocol/qualification fails: display installed version separately from run… | BLOCKED | E not run; K BLOCKED; S not run |
| APP-16 | P1 | Open selected desktop app, show verified download, and open official documentation through supported routes; w… | BLOCKED | E not run; K BLOCKED |

## 5.3 Settings, native customizations, and authority boundaries

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| CONF-01 | P0 | Read and edit approved global/project Codex TOML, Claude JSON, AGENTS.md and CLAUDE.md; preview exact before/a… | PASS | E not run; S PASS · other hosts: 1 BLOCKED |
| CONF-02 | P0 | Malformed JSON/TOML, array/non-object settings JSON, oversized input and arbitrary file path are rejected with… | **FAIL** | S **FAIL**; U **FAIL** · other hosts: 1 BLOCKED |
| CONF-03 | P0 | External file modification after read, after preview and during apply invalidates the write. A changed parent,… | PASS | S PASS · other hosts: 1 BLOCKED |
| CONF-04 | P0 | Active sessions block configuration writes. Wrong, expired, tampered, replayed or renderer-forged native appro… | PASS | E not run; S PASS · other hosts: 1 BLOCKED |
| CONF-05 | P0 | Success creates an encrypted backup and atomic intended replacement; crash around replacement reconciles as no… | PASS | S PASS · other hosts: 1 BLOCKED |
| CONF-06 | P1 | A written file remains distinct from native loaded state. Open the provider, verify effective settings and man… | not run | E not run; N1 not run · other hosts: 1 BLOCKED |
| CONF-07 | P1 | Ordinary native sessions discover the project's approved native skills, plugins, MCP servers, hooks, custom co… | not run | N1 not run; P not run · other hosts: 1 BLOCKED |
| CONF-08 | P0 | Restricted qualification/review/usage sessions disable only the customizations prescribed by that route. A hoo… | not run | N0 not run; N1 not run; P not run · other hosts: 1 BLOCKED |
| CONF-09 | P1 | Native plugin/skill install, removal, update and configuration take their native routes; unsupported Topsl man… | not run | E not run; N1 not run · other hosts: 1 BLOCKED |
| CONF-10 | P0 | Auto-accept levels Off, Sandboxed and Everything: each write/edit route uses the intended native policy; revie… | PASS | E not run; S PASS · other hosts: 1 BLOCKED |
| CONF-11 | P0 | Enable/disable Claude transcript reading and structured route through the real broker; turning off takes immed… | PASS | E not run; S PASS · other hosts: 1 BLOCKED |
| CONF-12 | P1 | Paper/Night/System, prior view migration, project-specific ordinary terminal mode and persisted settings survi… | not run | E not run · other hosts: 1 BLOCKED |
| BOUND-01 | P0 | Unknown/malformed commands, forged sender frames, invalid IDs and renderer-injected authority are rejected. Un… | PASS | E not run; S PASS |
| BOUND-02 | P0 | Renderer has no Node integration, context isolation and sandbox remain enabled, arbitrary navigation/new windo… | not run | E not run |
| BOUND-03 | P0 | Project A command references project B's task/run/candidate/grant or stale selection: reject unauthorized acce… | PASS | E not run; S PASS |
| BOUND-04 | P0 | Inject malicious historical text, Markdown/HTML, terminal escapes and secret-like canaries into output; render… | not run | E not run; P not run |
| BOUND-05 | P0 | Service exit/shutdown revokes grants and closes owned sessions; any child not proven exited remains uncertain.… | PASS | P PASS; S PASS |

## 5.4 Usage, provider allowances, and reporting

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| USAGE-01 | P0 | Duplicate deltas, cumulative snapshots, out-of-order ordinals, overlap between session/turn scope and overlapp… | PASS | S PASS; U PASS · other hosts: 1 BLOCKED |
| USAGE-02 | P0 | Cached input included versus excluded from input totals, absent cached values, mixed providers and imported es… | PASS | U PASS · other hosts: 1 BLOCKED |
| USAGE-03 | P1 | Usage changes publish fresh state and survive restart; project, workflow, provider and run filters agree with … | not run | E not run; S not run · other hosts: 1 BLOCKED |
| USAGE-04 | P0 | Codex allowance refresh sends account and rate-limit reads only, starts no thread/turn, and binds the result t… | PASS | N0 not run; N1 not run; P PASS · other hosts: 1 BLOCKED |
| USAGE-05 | P1 | Primary/secondary/multiple buckets, sparse rolling updates, omitted fields, credits and provider denial: retai… | PASS | E not run; P PASS; U PASS · other hosts: 1 BLOCKED |
| USAGE-06 | P1 | At the current 15-minute freshness boundary, just after it, after exact reset time, and across clock changes: … | PASS | E not run; U PASS · other hosts: 1 BLOCKED |
| USAGE-07 | P0 | Claude `/usage` reader uses only the approved native display route, returns quota windows, retains native rese… | PASS | N1 PASS; P PASS · other hosts: 1 BLOCKED |
| USAGE-08 | P0 | Claude display arrives fragmented, ANSI-decorated, partial, unfamiliar, statistical rather than quota, or with… | PASS | E not run; P PASS · other hosts: 1 not run |
| USAGE-09 | P0 | Account/profile hash differs before/after Claude read; concurrent refresh, timeout, exit or shutdown occurs: r… | PASS | N1 n/a; P PASS · other hosts: 1 not run |
| USAGE-10 | P1 | Failed allowance refresh keeps older values with failure and freshness labels. Exercise a real Topsl Codex rea… | PASS | E PASS; N1 not run; S PASS · other hosts: 1 BLOCKED |
| USAGE-11 | P1 | Owner budgets for local day/week/month, Monday boundary, month length, DST/timezone changes, zero/invalid inpu… | PASS | E not run; U PASS · other hosts: 1 BLOCKED |
| USAGE-12 | P0 | Exhaust an owner-set provider token budget: ordinary/direct work is not globally stopped, while current loop c… | PASS | E not run; S PASS · other hosts: 1 BLOCKED |
| USAGE-13 | P1 | Save/remove budget, switch provider/project, refresh during running work and reopen profile: cards retain corr… | not run | E not run · other hosts: 1 BLOCKED |
| USAGE-14 | P1 | Large ledger, repeated snapshots, active run crossing budget period and late usage arrival: define attribution… | not run | L not run; S not run · other hosts: 1 BLOCKED |
| USAGE-15 | P1 | Per-project `usage-budget-save/query`: token and wall-time limits independently set, null-cleared, invalidated… | PASS | E not run; S PASS; U PASS · other hosts: 1 BLOCKED |

## 5.5 Read-only context CLI and MCP connection

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| MCP-01 | P0 | Create one project-scoped grant through the desktop approval path; socket/named-pipe access, random grant/toke… | PASS | P PASS; S PASS |
| MCP-02 | P0 | Expired/revoked grant, wrong token, wrong project, withheld message/conversation/run or revoked attempt: rejec… | PASS | P PASS; S PASS |
| MCP-03 | P1 | Exercise `search`, `history`, `search-page`, `history-page`, `status`, and `mcp` CLI modes; validate output, e… | PASS | P PASS |
| MCP-04 | P0 | Pagination with limit 1/50 and invalid limits, changed query/scope, reused cursor, deleted records, Unicode an… | PASS | P PASS; S PASS |
| MCP-05 | P0 | MCP initialize/list/call, notification, malformed JSON, oversized line, unknown method/tool and concurrent IDs… | **FAIL** | P **FAIL** |
| MCP-06 | P0 | Attempt to install/update an application, write configuration, execute a run or grant approval through this en… | PASS | P PASS; S PASS |
| MCP-07 | P0 | Close/restart Topsl during a request; grants from the former process cannot be revived, pending clients termin… | PASS | P PASS; S PASS |
| MCP-08 | P1 | Display the native client command, use a real supported MCP client, and test packaged CLI resolution on each O… | PASS | E not run; K PASS; N0 not run · other hosts: 3 BLOCKED |

## 5.6 Optional encrypted portable replication

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| REPL-01 | P0 | Feature off by default; device, project allowlist, mapping and owner decisions require their exact native appr… | PASS | E not run; S PASS |
| REPL-02 | P0 | Approved peers exchange signed encrypted chunks; tampered manifest/chunk/GCM tag, wrong peer, missing chunk, w… | PASS | P not run; S PASS |
| REPL-03 | P1 | Resume after receiver restart, duplicate chunks and duplicate completed transfer converge to one logical recor… | PASS | P not run; S PASS |
| REPL-04 | P0 | Two independently initialized owners or conflicting authority observations pause execution. Transfer completio… | PASS | S PASS |
| REPL-05 | P0 | Imported workspace reference remains unavailable until a separate local folder mapping is approved; changed ma… | PASS | E not run; S PASS |
| REPL-06 | P0 | Conflicting edits retain both branches; explicit resolution converges; delayed ancestor import never rolls bac… | PASS | S PASS |
| REPL-07 | P0 | Deletion propagates minimal tombstones, removes staged/export/conflict derivatives and prevents replay resurre… | PASS | S PASS |
| REPL-08 | P0 | Reject credentials, grant/database paths, private keys, nested secret-like fields and unsupported native recor… | **FAIL** | S **FAIL** |
| REPL-09 | P0 | Revoke device/project permission during an incomplete transfer or after prior approval; later chunks/imports a… | PASS | S PASS |
| REPL-10 | P1 | Large transfer, interrupted disk write, storage exhaustion, concurrent local edit and repeated reconciliation … | **FAIL** | L not run; S **FAIL** |

## 5.7 Coordinator membership, planning, decisions, and execution

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| TEAM-01 | P0 | Parameterize every built-in and custom role with each eligible Codex/Claude route, then swap coordinator/revie… | PASS | E not run; N1 not run; P not run; S PASS; U PASS |
| TEAM-02 | P0 | Configure1,2,3,5,8,12,64 members; request12 with policy8, restart, raise policy12. Try policy65. | PASS | E not run; N1 not run; P not run; S PASS; U PASS |
| TEAM-03 | P0 | Pin five reviewers with two exact choices and three Auto slots; vary exact count, maxCount, required diversity… | **FAIL** | E not run; N1 not run; S not run; U **FAIL** |
| TEAM-04 | P0 | Run two members of the same model/provider/account; retry one, change its binding mid-round, deliver the old m… | PASS | E not run; N1 not run; P not run; S PASS; U PASS |
| TEAM-05 | P1 | Apply settings at application/project/goal/task scopes via conversation and editor; merge versus replace; rele… | PASS | E not run; S PASS; U PASS |
| TEAM-06 | P0 | For N5 test all five, count three, fraction 2/3, required endorser dissent, absent required contributor, dupli… | PASS | E not run; S PASS; U PASS |
| TEAM-07 | P0 | Propose incompatible plans; inject duplicate decision events; let reconciliation exhaust, then choose a branch… | PASS | E not run; S PASS; U PASS |
| TEAM-08 | P0 | Delegate a cycle, unknown dependency, wrong-purpose role, malformed partition count, stale role definition/top… | PASS | E not run; S PASS; U not run |
| TEAM-09 | P0 | Three implementation partitions with predecessor-dependent follow-up; integrate disjoint changes and then conf… | PASS | E not run; P not run; S PASS |
| TEAM-10 | P0 | Five reviewers: four clean, one high-severity defect; duplicate findings on same/nearby lines; missing/invalid… | PASS | E not run; S PASS; U PASS |
| TEAM-11 | P0 | Five members, execution width two, capacity two; variable per-provider cap; unknown fan-out; sequential; stric… | PASS | E not run; N1 not run; P not run; S PASS; U PASS |
| TEAM-12 | P0 | Accept/apply with stale digest, changed candidate, invalidated check, dirty/untracked folder, new HEAD, relink… | not run | E not run; P not run; S not run; U not run |
| TEAM-13 | P1 | Information goal with multiple researchers and artifacts; mixed conversation routing new/update/related/status… | **FAIL** | E not run; S **FAIL** |
| TEAM-14 | P1 | Reopen legacy singleton Build and review drafts/presets including Claude assisted terminal steps after changin… | PASS | E not run; S not run; U PASS |

## 5.8 Goal loops and Endless mode

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| LOOP-01 | P0 | Flag off, create/start command, flag on/create only, refuse start dialog, approve exact start digest; fabricat… | PASS | E not run; P PASS; S PASS; U PASS · other hosts: 1 BLOCKED |
| LOOP-02 | P0 | One goal with a known failing and then passing protected check; coordinators falsely claim success on failing … | PASS | E not run; P not run; S PASS; U not run · other hosts: 1 BLOCKED |
| LOOP-03 | P0 | Three required goals plus optional goal; satisfy them at different checkpoints, regress first during third, th… | PASS | E not run; P not run; S PASS; U not run · other hosts: 1 BLOCKED |
| LOOP-04 | P1 | Already-satisfied goal; impossible/conflicting goals; all goals cancelled; information-only goal; dependency c… | PASS | E not run; S PASS · other hosts: 1 BLOCKED |
| LOOP-05 | P0 | Add/edit/remove/reprioritize a goal during organization, work, final assessment and just before promotion; sub… | PASS | E not run; S PASS · other hosts: 1 BLOCKED |
| LOOP-06 | P1 | Generate criteria for ambiguous goals, later replace with user criteria; duplicate text/IDs; parse membership … | PASS | E not run; S not run; U PASS · other hosts: 1 BLOCKED |
| LOOP-07 | P0 | Wrong recursive-loop-v1 stage/mode/revisions/checkpoint/topology/authority/idempotency;0/5 decisions; valid sc… | PASS | E not run; S not run; U PASS · other hosts: 1 BLOCKED |
| LOOP-08 | P1 | Hard and easy equal-priority goals; repeated failing approach paraphrased at same content; then new approach/c… | PASS | E not run; S PASS · other hosts: 1 BLOCKED |
| LOOP-09 | P0 | Endless promotes an improvement, assesses again, then no opportunity; advance fake clock through backoff cap. | **FAIL** | E not run; P PASS; S **FAIL** · other hosts: 1 BLOCKED |
| LOOP-10 | P1 | Score opportunities at threshold-ε/exact/+ε; reorder words, change numeric requirement, reject then propose ag… | PASS | E not run; S not run; U PASS · other hosts: 1 BLOCKED |
| LOOP-11 | P0 | Stop monitoring run; deliver due wakeup, quota renewal, route change and restart in every order. | PASS | E not run; S PASS · other hosts: 1 BLOCKED |
| LOOP-12 | P1 | Project edit modifies tracked content without HEAD/index time changes, then Git index/HEAD changes; monitoring… | not run | E not run; S not run · other hosts: 1 BLOCKED |
| LOOP-13 | P0 | Disable Recursive Looping while Goal/Endless runs are active or monitoring, then request Stop, Pause and resta… | **FAIL** | E not run; P **FAIL**; S **FAIL** · other hosts: 1 BLOCKED |
| LOOP-14 | P0 | Update loop policy while work runs: enable automatic checks, remove provider exclusion, narrow authority, or c… | not run | E not run; S not run · other hosts: 1 not run |

## 5.9 Automatic roles, model selection, optimization, and user overrides

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| AUTO-01 | P1 | Cold start with one/two providers; remove highest-ranked route; unavailable unpinned coordinator; no valid dec… | PASS | E not run; N1 not run; S not run; U PASS |
| AUTO-02 | P0 | Lock exact team/count/provider exclusion/always-present role/exact active-role count; propose retire/split/mer… | PASS | E not run; N1 not run; S PASS; U PASS |
| AUTO-03 | P0 | Freeze one role and partially pin another; change override mid-iteration; restart; release one lock. | not run | E not run; S not run |
| AUTO-04 | P0 | Change coordinator roster under three-of-five rule; outgoing dissent; incoming quorum; late old-generation dec… | PASS | E not run; S PASS |
| AUTO-05 | P1 | Create/activate/retire/split/merge custom specialists, including purpose mismatch, duplicate IDs, locked linea… | PASS | E not run; S PASS; U PASS |
| AUTO-06 | P1 | Seed outcome corpus low/medium/high difficulty, invalid/missing/failed results, zero/2/3/9/10 samples, equal e… | **FAIL** | E not run; N1 not run; S not run; U **FAIL** |
| AUTO-07 | P1 | Routine change at dwell2/3; weak evidence5/6; operations2/3; A→B→A and repeating topology; actual trigger vers… | PASS | E not run; S PASS; U PASS |
| AUTO-08 | P1 | Propose successive previously untried models across >200 outcome records; compare proposals/actual turn share. | PASS | E not run; N1 not run; S **NOT IMPL**; U PASS |
| AUTO-09 | P1 | Routine experiment0/2 promotions versus prior1/2; then1/2 versus prior2/2; trigger-origin change. | PASS | E not run; S not run; U PASS |
| AUTO-10 | P1 | Same model ID across providers, model version/binding change, unrelated task families and other project outcom… | **FAIL** | E not run; S not run; U **FAIL** |
| AUTO-11 | P1 | Set active-role-count override to 0, 1, 1.5, a very large integer and an impossible value under locked-role co… | **FAIL** | E not run; S **FAIL**; U **FAIL** |

## 5.10 Checkpoints, promotion, publication, and durable control

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| STATE-01 | P0 | Two accepted iterations add/update/delete files; corrupt original folder after starting; third candidate rejec… | PASS | E not run; K not run; N1 not run; P PASS; S PASS · other hosts: 1 BLOCKED |
| STATE-02 | P0 | Candidate edits/removes protected tests, config or referenced scripts; new test added; check unavailable/error… | PASS | E not run; K not run; N1 not run; S PASS · other hosts: 1 BLOCKED |
| STATE-03 | P0 | Required reviewer fails/disappears; required check passes for older candidate; mutate bytes after evaluation b… | not run | E not run; K not run; N1 not run; S not run · other hosts: 1 not run |
| STATE-04 | P0 | Promote same candidate twice, replay boundary, simulate crash after transaction before child settle/event. | **FAIL** | E not run; K not run; N1 not run; S **FAIL** · other hosts: 1 BLOCKED |
| STATE-05 | P0 | Kill at persisted launch before spawn, after process spawn before attempt binding, after accounting write, aft… | **FAIL** | E not run; K not run; N1 not run; P not run; S **FAIL** · other hosts: 1 **FAIL** |
| STATE-06 | P0 | Pause/stop during boundary, organization, endorsement, planning, implementation, integration, review, check, e… | not run | E not run; K not run; N1 not run; S not run · other hosts: 1 not run |
| STATE-07 | P0 | Resume, quit/reopen under resumeAfterRestart false/true; checkpoint missing/corrupted; old result arrives afte… | PASS | E not run; K not run; N1 not run; S PASS · other hosts: 1 BLOCKED |
| STATE-08 | P0 | Publish checkpoint1, checkpoint2 increment, same checkpoint again; dirty/untracked/foreign edit, changed HEAD,… | PASS | E not run; K not run; N1 not run; S PASS · other hosts: 1 BLOCKED |
| STATE-09 | P0 | Fail publication before first write, after kth write, after readback before receipt; restart and repeat comman… | PASS | E not run; K not run; N1 not run; S PASS · other hosts: 1 BLOCKED |
| STATE-10 | P1 | Commit published files unchanged then reconcile; change a published path before commit; untracked user file/ig… | PASS | E not run; K not run; N1 not run; S PASS · other hosts: 1 BLOCKED |
| STATE-11 | P1 | Export earlier/head checkpoint after retention; remove owned temporary copy; delete unrelated user directory m… | PASS | E not run; K not run; N1 not run; S PASS · other hosts: 1 BLOCKED |
| STATE-12 | P0 | Two windows concurrently start/pause/edit policy/publish with repeated/conflicting command IDs and stale expec… | **FAIL** | E not run; K not run; N1 not run; S **FAIL** · other hosts: 1 BLOCKED |

## 5.11 Loop resources, evidence quality, and extended operation

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| OPS-01 | P0 | Decision, endorsement, failed/retried member, child and repair turns consume a small run/rolling allowance; ne… | PASS | E not run; N1 not run; P not run; S PASS · other hosts: 1 BLOCKED |
| OPS-02 | P0 | >2000 accounting updates inside one rolling window, crash between usage record and iteration cursor update, th… | **FAIL** | E not run; L not run; S **FAIL** · other hosts: 1 BLOCKED |
| OPS-03 | P1 | Runtime quota reached/reset; stale/unknown quota; owner provider token budget; missing token measurements. | not run | E not run; N1 not run; S not run · other hosts: 1 not run |
| OPS-04 | P1 | Multiple Endless/Goal runs plus direct user chat/Build and review; vary reserve and per-provider cap; maintain… | not run | E not run; L not run; N1 not run; S not run · other hosts: 1 not run |
| OPS-05 | P0 | Stand-in silent stall, message-finished stall, retry notices, continuous token stream, child ignoring interrup… | PASS | E not run; N1 not run; P PASS; S PASS · other hosts: 1 BLOCKED |
| OPS-06 | P1 | 1,000+ scripted boundaries with successes/rejections/replans/topology changes,6h/24h stand-in soak, timeline c… | PASS | E not run; L not run; S PASS · other hosts: 1 BLOCKED |
| OPS-07 | P0 | Goal claims satisfied citing real but semantically wrong file; evidence beyond10th file/beyond8000 chars/delet… | not run | E not run; N1 not run; S not run · other hosts: 1 not run |
| OPS-08 | P1 | Small window/large text/keyboard-only screen with5/8/12 members; update third/fifth/last member; long role/mod… | not run | E not run; S n/a · other hosts: 1 BLOCKED |
| OPS-09 | P1 | Electron journey through branch choice, minority finding, finding disposition, repair, required check, conflic… | not run | E not run; S n/a · other hosts: 1 BLOCKED |
| OPS-10 | P1 | Review canonical docs/screens against feature gates and actual evidence matrix. | **FAIL** | E not run; S **FAIL** · other hosts: 1 BLOCKED |

## 5.12 Provider connection, protocol, authentication, and approvals

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| PR-01 | P0 | Untrusted executable; invoke inspect/chat/workflow/terminal through service. | PASS | N0 not run; N1 BLOCKED; P PASS; S PASS; U not run |
| PR-02 | P0 | Trust binary, then replace bytes while keeping path/version label. | PASS | N0 not run; N1 BLOCKED; P PASS; S PASS; U PASS |
| PR-03 | P0 | Set API-key/external-token/cloud-provider billing overrides; attempt structured dispatch. | PASS | N0 not run; N1 BLOCKED; P PASS; S PASS; U not run |
| PR-04 | P0 | Start Codex chat, then change native account or profile and resume. | PASS | N0 not run; N1 BLOCKED; P PASS; S PASS; U not run |
| PR-05 | P1 | Paginated Codex model list with full IDs, names, defaults, modalities, efforts; 0/1/many pages. | PASS | N0 not run; N1 BLOCKED; P not run; S not run; U PASS |
| PR-06 | P0 | Request unavailable model/unsupported effort or receive a different effective model/effort. | PASS | N0 not run; N1 BLOCKED; P PASS; S not run; U PASS |
| PR-07 | P0 | Arbitrarily chunk NDJSON across UTF-8 boundaries; partial/final duplicates; intentionally repeated distinct me… | PASS | N0 not run; N1 BLOCKED; P PASS; S PASS; U PASS |
| PR-08 | P0 | Malformed JSON, oversized record/event count, same event ID with different payload, wrong session or unknown a… | PASS | N0 not run; N1 BLOCKED; P PASS; S PASS; U PASS |
| PR-09 | P1 | Known informational event or new optional additive fields. | PASS | N0 not run; N1 BLOCKED; P not run; S not run; U PASS |
| PR-10 | P0 | Claude `message_delta.delta` omits `type`; final result is `is_error: true, subtype: success`. | PASS | N0 not run; N1 BLOCKED; P PASS; S PASS; U PASS |
| PR-11 | P0 | Review thread receives command/file-change escalation; same request replayed or targets another thread/turn. | PASS | N0 not run; N1 BLOCKED; P PASS; S PASS; U not run |
| PR-12 | P0 | Codex reports permissions unlike requested sandbox/approval policy. | PASS | N0 not run; N1 BLOCKED; P PASS; S PASS; U PASS |
| PR-13 | P1 | Command/file approval contains multi-file rename, additional filesystem/network rights, lasting amendment, mis… | **FAIL** | N0 not run; N1 BLOCKED; P PASS; S PASS; U **FAIL** |
| PR-14 | P0 | Cancel/close during pending approval, wait past expiry, then reply with old digest. | PASS | N0 not run; N1 BLOCKED; P PASS; S PASS; U not run |
| PR-15 | P0 | Interrupt exactly native thread/turn; late completion after interrupt; exit event delayed. | PASS | L not run; N0 not run; N1 BLOCKED; P PASS; S not run; U not run |
| PR-16 | P0 | Provider dies after spawn but before/after turn acknowledgement; restart Topsl. | PASS | N0 not run; N1 BLOCKED; P PASS; S PASS; U not run |

## 5.13 Native terminals, chat presets, and assisted handoffs

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| TM-01 | P0 | Enumerate every provider terminal mode; run fixture CLI that records argv. | PASS | E not run; N1 BLOCKED; P PASS; S PASS; U PASS |
| TM-02 | P0 | Select Bypass/Full access, deny or cancel native confirmation, then retry/remember settings. | PASS | E PASS; N1 BLOCKED; P PASS; S PASS; U PASS |
| TM-03 | P1 | Choose ordinary mode in project A and different mode in B; restart; switch providers. | PASS | E not run; N1 BLOCKED; P PASS; S not run; U not run |
| TM-04 | P1 | Native runtime rejects chosen mode. | PASS | E not run; N1 BLOCKED; P PASS; S PASS; U not run |
| TM-05 | P0 | All four Codex chat presets; switch preset when continuing same native chat. | PASS | E not run; N1 BLOCKED; P PASS; S PASS; U PASS |
| TM-06 | P0 | Toggle auto-accept off/sandboxed/everything before and during run and while approval already waits. | PASS | E not run; N1 BLOCKED; P PASS; S PASS; U PASS |
| TM-07 | P1 | PTY resize, Unicode output/input, large bounded output, native slash commands/login prompts, close/reopen. | PASS | E not run; N1 BLOCKED; P PASS; S PASS; U not run |
| TM-08 | P0 | External assisted open loses acknowledgement. | PASS | E not run; N1 BLOCKED; P not run; S PASS; U not run |
| TM-09 | P0 | Import assisted reviewer JSON with exact candidate/spec, then wrong line/revision/JSON or drift. | PASS | E not run; N1 BLOCKED; P not run; S PASS; U not run |
| TM-10 | P1 | Handoff exceeds allowed export bytes or contains large binary/omitted context. | PASS | E not run; N1 BLOCKED; P not run; S PASS; U not run |
| TM-11 | P1 | Call reserved `runtime-login`; then open `terminal-open` with `login: true` for a selected trusted installatio… | PASS | E not run; N1 BLOCKED; P PASS; S PASS; U not run |

## 5.14 Claude structured execution, qualification, and stall recovery

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| CL-01 | P0 | Fresh profile; renderer tries enable without native confirmation; enable legitimately and restart; disable. | PASS | E not run; S PASS; U PASS |
| CL-02 | P0 | Route off, then on but unqualified; connect/account inspect; direct edit/review and each coordinator purpose. | PASS | E not run; N1 not run; P PASS; S PASS |
| CL-03 | P0 | Review, candidate-reader review, edit argument profiles captured by fixture. | PASS | E not run; N1 not run; P PASS; U PASS |
| CL-04 | P0 | Explicit ungranted tool, non-subscription API-key source in a live turn, or wrong session; separately omit ini… | PASS | E not run; N1 not run; P PASS |
| CL-05 | P0 | Qualification returns four independent valid sessions with expected reported model and probes. | PASS | E not run; N1 BLOCKED; S PASS · other hosts: 1 BLOCKED |
| CL-06 | P0 | Separately fail reader invocation, missing marker in reply, outside write skipped, outside write lands, no den… | PASS | E not run; N1 not run; P PASS; S PASS |
| CL-07 | P0 | Name alias but runtime reports different full ID; then qualify exact full ID. | PASS | E not run; N1 not run; S PASS |
| CL-08 | P0 | Change executable/account/profile/host/settings/argument profile and cross 30-day expiry. | PASS | E not run; N1 not run; U PASS |
| CL-09 | P0 | Sleep after message-stop; use injectable clock/short fixture deadlines. | PASS | E not run; N1 not run; P PASS; U PASS |
| CL-10 | P0 | No complete parsed stdout records arrive. | PASS | E not run; N1 not run; P PASS; U PASS |
| CL-11 | P0 | New message, completed result, `api_retry` at just before/after deadline; ordinary irrelevant records continue… | PASS | E not run; P PASS; U PASS |
| CL-12 | P0 | Stalled turn retries through coordinator; emit delayed old result and reader call after stop. | PASS | E not run; P PASS; S not run; U PASS |
| CL-13 | P0 | Stall kill cannot establish descendants stopped or signal fails. | PASS | E not run; P PASS; S PASS; U PASS |
| CL-14 | P0 | Process continuously emits complete valid records for a long duration, or emits retry records indefinitely; us… | PASS | E not run; U PASS |
| CL-15 | P1 | Authorized native route qualification across new model/runtime versions/OSes. | PASS | E not run; N0 not run; N1 BLOCKED; S PASS |
| CL-16 | P0 | Emit raw stdout bytes or partial NDJSON without a complete record; compare complete valid records; send messag… | PASS | E not run; U PASS |
| CL-17 | P0 | Temporary MCP configuration contains a bearer token; inspect access on POSIX and Windows with a second unprivi… | PASS | E not run; U PASS · other hosts: 1 BLOCKED |
| CL-18 | P0 | Run the account-read/qualification fixture on Windows and POSIX through supported executable launchers; distin… | PASS | E not run; S PASS · other hosts: 1 BLOCKED |

## 5.15 Build and review, repair, Claude handback, and final acceptance

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| BW-01 | P1 | New workflow draft; reopen old draft created under older default pairing; change project. | PASS | E not run; P not run; S PASS |
| BW-02 | P0 | Capture objective, nonempty criteria, selected roles, environment/checks, tracked/untracked scope; mutate befo… | PASS | E not run; P PASS; S PASS |
| BW-03 | P0 | Qualified fixture Codex/Codex and synthetic reverse assignments; complete clean build/review/check. | PASS | E PASS; P PASS; S PASS |
| BW-04 | P0 | Claude→Codex, Codex→Claude, Claude→Claude Build and review on current native-step path. | PASS | E not run; P PASS; S PASS |
| BW-05 | P0 | Claude review opens and attempts edits. | PASS | E not run; P PASS; S PASS |
| BW-06 | P0 | Hand back build/review before open, while terminal runs, after exit without stopped confirmation, after full c… | PASS | E not run; P PASS; S PASS |
| BW-07 | P0 | Restart Topsl while Claude step waits or open outcome is uncertain. | PASS | E not run; P PASS; S PASS |
| BW-08 | P1 | Paste review vs transcript-import review vs Codex managed review. | PASS | E not run; P PASS; S PASS |
| BW-09 | P0 | Transcript-reading setting off; on via native approval; wrong latest session/root, incomplete final reply, sid… | PASS | E not run; P PASS; S PASS |
| BW-10 | P0 | Reviewer uses candidate tools; builder attempts same tool; review errors. | PASS | E not run; N0 not run; P PASS; S PASS |
| BW-11 | P0 | Reviewer emits a progress note before final JSON, prose final, malformed JSON, wrong revision/path/line. | PASS | E not run; P PASS; S PASS |
| BW-12 | P0 | Valid findings trigger one changed repair and re-review; attempt repeated unchanged repairs. | PASS | E not run; P not run; S not run; U PASS |
| BW-13 | P0 | Owner rejects unsupported finding with rationale, stale finding revision, blank rationale, or already supersed… | PASS | E not run; P PASS; S PASS |
| BW-14 | P0 | Mutate candidate or reviewer materialized snapshot after apparently clean review; restart before acceptance. | PASS | E not run; P PASS; S PASS |
| BW-15 | P0 | Failed check, absent check, stale check, forged verification, externally changed source at acceptance. | PASS | E not run; P PASS; S PASS |
| BW-16 | P0 | Large candidate without installed qualified reader. | PASS | E not run; P not run; S not run; U PASS |
| BW-17 | P0 | Build waits on command/file approval; allow once/deny and pause/auto-accept race. | PASS | E not run; P PASS; S PASS |
| BW-18 | P0 | Specifications change during running native step or between checks and acceptance. | PASS | E not run; P PASS; S PASS |
| BW-19 | P1 | Execute separately authorized live-session four-pairing matrix using seeded discount project. | BLOCKED | E not run; N1 BLOCKED |
| BW-20 | P0 | Manual explicit final acceptance of exact candidate, followed by repeat/stale acceptance and apply/export chec… | PASS | E not run; P PASS; S PASS |
| BW-21 | P0 | Invoke `builder-reviewer-cancel` before dispatch, during managed build/review, during preparation/check, and w… | **FAIL** | E not run; P PASS; S **FAIL** |

## 5.16 Candidate manifests, diffs, artifacts, and scoped readers

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| CA-01 | P0 | Capture text, large text beyond initial prompt, unchanged binary, executable bit change. | PASS | E not run; P not run; S not run; U PASS |
| CA-02 | P0 | Tracked build/release paths, rename, staged deletion, new untracked artifact. | PASS | E not run; P not run; S not run; U PASS |
| CA-03 | P0 | Symlink/path traversal/hardlink-parent swap/case alias/submodule/protected secret candidate. | PASS | E not run; P not run; S not run; U PASS |
| CA-04 | P0 | Cancel capture, exceed each bounded file/project/vault budget, race content modification. | PASS | E not run; L PASS; P not run; S not run; U not run |
| CA-05 | P0 | Identical candidate bytes in distinct projects/workspaces. | PASS | E not run; P not run; S not run; U PASS |
| CA-06 | P0 | Read/search/list immutable snapshot after live source drift. | PASS | E not run; P PASS; S PASS; U PASS |
| CA-07 | P0 | Grant expiry/revocation while paginating or tool call races attempt completion. | PASS | E not run; P PASS; S PASS; U PASS |
| CA-08 | P0 | Mandatory requirements exceed byte/token reserve; unknown context window; binary input cannot fit as text. | PASS | E not run; P not run; S not run; U PASS |
| CA-09 | P1 | Text diff add/delete/modify, binary replacement, no-op and mode-only change; full text pagination. | PASS | E not run; P not run; S PASS; U PASS |
| CA-10 | P0 | Approve new output exact bytes, change before action, replay, reject later. | PASS | E not run; P not run; S not run; U PASS |
| CA-11 | P0 | Proposed unexpected output recapture then separate manifest review; mutate proposal after approval. | PASS | E not run; P not run; S not run; U PASS |
| CA-12 | P0 | Amend allowed scope after old passing review/check. | PASS | E not run; P not run; S not run; U PASS |
| CA-13 | P0 | Binary output reviewed/rejected/manually attested then changed. | PASS | E not run; P not run; S PASS; U PASS |
| CA-14 | P1 | Disable manifest rollout and reopen old evidence/migrate old candidate format. | PASS | E not run; P not run; S not run; U PASS |

## 5.17 Reproducible environments and protected checks

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| CK-01 | P0 | Detect environments repeatedly; capture approved locked-node/offline recipe and selected check. | PASS | K not run; P PASS; S PASS |
| CK-02 | P0 | Fresh locked dependencies with no existing node_modules, fake native credential env/caches. | PASS | K not run; P PASS; S PASS |
| CK-03 | P0 | Missing dependency archive/registry, unreviewed lifecycle hook, timeout/cancel. | PASS | K not run; P PASS; S PASS |
| CK-04 | P0 | Approve exact hook command, then change package/hook bytes/args/tool. | PASS | K not run; P PASS; S PASS |
| CK-05 | P0 | Modify lockfile/dependency tree, candidate toolchain or external npm CLI after review. | PASS | K not run; P PASS; S PASS |
| CK-06 | P0 | Candidate modifies/removes tests, acceptance script, selected root script, check config, package-script indire… | PASS | K not run; P PASS; S PASS |
| CK-07 | P0 | Two callers concurrently spend same check approval. | PASS | K not run; P PASS; S PASS |
| CK-08 | P0 | Approved bounded check authorization reused on repair; exhaust/revoke/expire/change recipe/project/workspace. | PASS | K not run; P PASS; S PASS |
| CK-09 | P0 | Check changes source/harness persistently, or creates unapproved shadow scripts; exit 0. | PASS | K not run; P PASS; S PASS |
| CK-10 | P0 | Execute check with extra live workspace file not in candidate. | PASS | K not run; P PASS; S PASS |
| CK-11 | P0 | Parallel checks use database/port/home/cache/output/temp. | PASS | K not run; P PASS; S PASS |
| CK-12 | P1 | Candidate check returns 1 after successful preparation. | PASS | K not run; P PASS; S PASS |
| CK-13 | P0 | Registry-fetch preparation recipe versus offline preparation; check command or hook attempts network access; r… | PASS | K not run; P not run; S PASS |
| CK-14 | P0 | Restart in later preparation dispatch gap after a previous completed/quiescent command. | PASS | K not run; P PASS; S PASS |
| CK-15 | P1 | Check emits oversize logs, secrets, long lines, descendant processes, timeout near process close. | PASS | K not run; P PASS; S PASS · other hosts: 1 BLOCKED |
| CK-16 | P0 | Call `check-execution-reconcile` on foreign-project, active, non-uncertain, identity-missing and inactive unce… | PASS | K not run; P PASS; S PASS · other hosts: 1 BLOCKED |
| CK-17 | P0 | Call `check-cleanup-retry` after committed result and injected cleanup failure; concurrently retry; use foreig… | PASS | K not run; P PASS; S PASS · other hosts: 1 BLOCKED |

## 5.18 Parallel specialists, advanced workflows, and routing presets

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| PW-01 | P0 | Two writers in approved distinct roots for same logical project; alias root as third writer. | PASS | E not run; N1 not run; P PASS; S PASS; U not run |
| PW-02 | P0 | Dirty source before managed workspace; change digest after capture or while folder review opens. | not run | E not run; N1 not run; P not run; S not run; U not run |
| PW-03 | P0 | Specialists modify outside declared ownership or staged deletion bypass. | **FAIL** | E not run; N1 not run; P **FAIL**; S **FAIL**; U not run |
| PW-04 | P0 | Individual workers' checks pass but combined candidate fails. | PASS | E not run; N1 not run; P PASS; S PASS; U not run |
| PW-05 | P0 | Overlapping edits from shared baseline; explicit conflict resolution. | PASS | E not run; N1 not run; P PASS; S PASS; U not run |
| PW-06 | P0 | Combined candidate accepted then source changes; review bytes withheld/mutated. | PASS | E not run; N1 not run; P PASS; S PASS; U not run |
| PW-07 | P0 | Unknown native fanout capability, capacity full, final event arrives while process stays alive. | PASS | E not run; L not run; N1 not run; P PASS; S PASS; U not run |
| PW-08 | P0 | Cancel active specialists; late result; cleanup while active/after stop. | PASS | E not run; L not run; N1 not run; P PASS; S PASS; U not run |
| PW-09 | P0 | Review integration plan then modify source/order/candidate before apply. | PASS | E not run; N1 not run; P PASS; S PASS; U not run |
| AD-01 | P0 | Advanced flag off, on without enforcer, fake renderer capability evidence. | PASS | E not run; N1 **NOT IMPL**; S PASS; U PASS |
| AD-02 | P0 | Independent proposals: two/many participants; try read peer before every output freezes. | PASS | E not run; S PASS; U PASS |
| AD-03 | P0 | Evaluate proposals with missing/duplicate rubric dimension, wrong target revision/protocol or forged evidence. | PASS | E not run; S PASS |
| AD-04 | P0 | Proposal selection plus manual proposal-review confirmation. | PASS | E not run; S PASS |
| AD-05 | P0 | Independent test author receives implementation/baseline before freezing tests. | PASS | E not run; S PASS |
| AD-06 | P0 | Frozen tests then actual execution against later pinned candidate; alter tests/check invocation. | PASS | E not run; P PASS; S PASS |
| AD-07 | P0 | Competing implementations share baseline; same checks against every candidate; select candidate then mutate by… | PASS | E not run; P PASS; S PASS |
| AD-08 | P0 | Pair debugging switch driver while attempt/writer active, then at stopped checkpoint with reproduction evidenc… | PASS | E not run; S PASS |
| AD-09 | P1 | Save routing preset with three or more same-role members across providers; duplicate identity/blank model/wron… | PASS | E not run; S PASS; U PASS |
| AD-10 | P1 | Measure routing using wrong project/provider/model, active attempt, stale preset revision; then genuine comple… | PASS | E not run; S PASS; U PASS |
| AD-11 | P1 | UI/catalog asks for debate or generic plan competition. | PASS | E not run; S PASS; U PASS |

## 5.19 History, handoffs, shared specifications, and context revisions

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| HX-01 | P0 | Explicit approved Codex/Claude JSONL sources with same native session ID in distinct actual profiles. | PASS | E not run; N1 BLOCKED; P not run; S PASS; U PASS |
| HX-02 | P0 | Append partial line; restart/replay; append rest and reconcile again. | PASS | E not run; N1 BLOCKED; P not run; S PASS; U PASS |
| HX-03 | P0 | Malformed complete record or native ID collision mid-batch. | PASS | E not run; N1 BLOCKED; P not run; S PASS; U PASS |
| HX-04 | P0 | Rotate/truncate/rewrite source, backwards timestamps, repeated content without native IDs. | PASS | E not run; N1 BLOCKED; P not run; S PASS; U PASS |
| HX-05 | P0 | Delete conversation/tombstone then restart, reapprove old file and append new content. | PASS | E not run; N1 BLOCKED; P not run; S PASS; U PASS |
| HX-06 | P0 | Symlink/approved path substitution, wrong cwd/session, parser version unknown or paused. | PASS | E not run; N1 BLOCKED; P not run; S PASS; U PASS |
| HX-07 | P1 | Claude bookkeeping/attachments/thinking/subagent side-chain records. | PASS | E not run; N1 BLOCKED; P not run; S PASS; U PASS |
| HX-08 | P0 | Preview/export historical context in both directions; attach a Claude→Codex snapshot; include hidden/other-pro… | PASS | E not run; N1 BLOCKED; P not run; S PASS; U PASS |
| HX-09 | P1 | 29/30/31 eligible messages, 11,999/12,000/12,001 chars each, total 149,999/150,000/150,001. | **FAIL** | E not run; N1 BLOCKED; P not run; S **FAIL**; U PASS |
| HX-10 | P0 | Attach a reviewed Codex-targeted snapshot, edit current selection, swap target/provider/project/conversation, … | **FAIL** | E not run; N1 BLOCKED; P not run; S **FAIL**; U not run |
| HX-11 | P1 | Scoped history beyond global window; equal timestamps/concurrent insert/update/delete; cursor swapped among pr… | PASS | E not run; L not run; N1 BLOCKED; P not run; S PASS; U PASS |
| HX-12 | P0 | Publish blocking specification/decision/interface while task runs or after old check pass. | PASS | E not run; N1 BLOCKED; P not run; S PASS; U not run |
| HX-13 | P0 | Publish shared revision with stale expected head/foreign project reference/oversize or missing required source… | PASS | E not run; N1 BLOCKED; P not run; S PASS; U not run |
| HX-14 | P0 | Active old attempt cannot be stopped/has uncertain outcome; request replacement after spec update. | PASS | E not run; N1 BLOCKED; P not run; S PASS; U not run |
| HX-15 | P1 | Advisory shared revision, update intent and checkpoint receipt. | PASS | E not run; N1 BLOCKED; P not run; S PASS; U not run |
| HX-16 | P0 | Directional native setting/name push targets changed profile/hash; readback differs. | PASS | E not run; N1 BLOCKED; P not run; S PASS; U not run |
| HX-17 | P1 | Export a retained handoff using `handoff-export` to a newly selected native destination; cancel selection, omi… | PASS | E not run; N1 BLOCKED; P not run; S PASS; U not run |

## 5.20 Projects, native discovery, opening, and registry synchronization

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| PJ-01 | P0 | Fresh profile; inspect known native source files without enabling; enable approved scope. | PASS | E PASS; K not run; N0 not run; N1 BLOCKED; P not run; S PASS |
| PJ-02 | P0 | Each supported source under custom CODEX_HOME/CLAUDE_CONFIG_DIR; unknown schema/relative/remote/control path. | PASS | E not run; K not run; N0 not run; N1 BLOCKED; P not run; S PASS |
| PJ-03 | P1 | Same folder via Codex desktop, Codex CLI, Claude config, symlink; separate worktrees/same remote/display name. | PASS | E not run; K not run; N0 not run; N1 BLOCKED; P not run; S PASS |
| PJ-04 | P0 | Native multi-root group, missing root or trust one root only. | PASS | E not run; K not run; N0 not run; N1 BLOCKED; P not run; S PASS |
| PJ-05 | P1 | Source rename/removal/corruption/deletion/access error, then valid recovery. | PASS | E not run; K not run; N0 not run; N1 BLOCKED; P not run; S PASS |
| PJ-06 | P0 | Startup/minute/manual refresh overlap, then Pause during read or after a native change was already dispatched. | PASS | E not run; K not run; N0 not run; N1 BLOCKED; P not run; S PASS |
| PJ-07 | P0 | Retarget trusted symlink or move folder; relink with active/uncertain writer or another project's folder. | PASS | E not run; K not run; N0 not run; N1 BLOCKED; P not run; S PASS |
| PJ-08 | P0 | Forged renderer project path/trust value; native opening of trusted project. | PASS | E not run; K not run; N0 not run; N1 BLOCKED; P not run; S PASS |
| PJ-09 | P1 | Open same folder in both CLIs and each supported desktop platform route. | PASS | E not run; K not run; N0 not run; N1 BLOCKED; P not run; S PASS · other hosts: 2 BLOCKED |
| PJ-10 | P0 | Claude folder path with Unicode, &, #, ?, %, spaces and hostile query-like text. | PASS | E not run; K not run; N0 not run; N1 BLOCKED; P not run; S PASS |
| PJ-11 | P0 | Enable Codex native sync without trust; then with trusted executable/profile. | PASS | E not run; K not run; N0 PASS; N1 BLOCKED; P not run; S PASS |
| PJ-12 | P0 | Codex API absent/malformed/unsupported schema/repeated pagination/limit overflow. | PASS | E not run; K not run; N0 not run; N1 BLOCKED; P not run; S PASS |
| PJ-13 | P0 | Lost create reply, restart, local name changes before reconciliation. | PASS | E not run; K not run; N0 not run; N1 BLOCKED; P not run; S PASS |
| PJ-14 | P0 | Rename/move native group with multiple roots/metadata; stale revision/order. | PASS | E not run; K not run; N0 not run; N1 BLOCKED; P PASS; S PASS |
| PJ-15 | P1 | Same folder belongs to multiple native groups; ordering changed; stale raw metadata name arrives. | PASS | E not run; K not run; N0 not run; N1 BLOCKED; P not run; S PASS |
| PJ-16 | P0 | Native project removed, sync/restart/re-enable. | PASS | E not run; K not run; N0 not run; N1 BLOCKED; P not run; S PASS |
| PJ-17 | P0 | Runtime/profile/trust changes while native connection active; retarget folder then export. | PASS | E not run; K not run; N0 not run; N1 BLOCKED; P not run; S PASS |
| PJ-18 | P1 | Independent app-server connection reads create/rename/order; delete native fixture. | PASS | E not run; K not run; N0 PASS; N1 BLOCKED; P not run; S not run |
| PJ-19 | P1 | Existing Codex desktop open while registry changes; fresh desktop launch and own sidebar refresh. | BLOCKED | E BLOCKED; K not run; N0 not run; N1 not run; P not run; S not run |
| PJ-20 | P0 | Concurrent external native rename/order between Topsl preflight and write; Topsl/name/native diverge. | PASS | E not run; K not run; N0 not run; N1 BLOCKED; P not run; S PASS |
| PJ-21 | P0 | Use `native-link-state` to unlink/relink a current native link and `native-root-map` to bind one root to an ap… | PASS | E not run; K not run; N0 not run; N1 BLOCKED; P not run; S PASS |

## 5.21 Desktop interaction, accessibility, and state freshness

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| UI-01 | P0 | First launch: empty profile, secure OS store, passphrase fallback, OS store locked | PASS | E PASS; K PASS · other hosts: 3 BLOCKED |
| UI-02 | P0 | Wrong, short, missing, Unicode passphrase; unknown vault format; missing key with existing DB | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-03 | P1 | All 11 navigation destinations, empty and populated | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-04 | P1 | Width boundary 899/900 px, 560×720 compact, normal desktop, 150%/200% zoom | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-05 | P1 | Command palette via mouse, Cmd/Ctrl+K, Escape, repeated opens | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-06 | P1 | Keyboard-only all essential tasks; screen readers on target desktop platforms | BLOCKED | E BLOCKED; K not run · other hosts: 3 BLOCKED |
| UI-07 | P1 | Paper, Night, System; runtime OS light/dark switch; reduced motion | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-08 | P1 | Chinese/English names, long paths, emoji, CJK IME prompt composition, multiline paste | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-09 | P0 | Rapid A→B→A project switches during delayed history/task/workflow requests | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-10 | P0 | Epoch reset, missing/out-of-order/duplicate events, disconnect/reconnect | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-11 | P1 | Refresh concurrently with task/action click; rejection and cancellation | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-12 | P1 | Projects: add/cancel/duplicate/untrusted/missing/relink; filter and Unicode paths | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-13 | P1 | Native project discovery and Codex synchronization, rename/order/pause/resume | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-14 | P1 | Applications: discovery, manual runtime choice, trust, updates, native-open, docs | not run | E not run; K not run · other hosts: 3 BLOCKED |
| UI-15 | P0 | Operation progress: download/install/update/cancel/retry/reconcile | not run | E not run; K not run · other hosts: 3 BLOCKED |
| UI-16 | P0 | Settings global/project config and instructions, provider switch during read | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-17 | P0 | Auto-accept levels, transcript reading, Claude structured route | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-18 | P1 | Sessions: new/select/history-open, draft retention, send/cancel/retry | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-19 | P1 | PTY native mode: output, resize, focus/paste, navigation/theme, close, shell crash | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-20 | P0 | History import/search/pagination/clear/open/local-delete | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-21 | P1 | Usage remaining, budgets, refresh failure/retry, unknown/partial usage | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-22 | P1 | Task/changes inspection at 1,004+ manifest paths and many findings | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-23 | P0 | Coordinator role editor and conversation controls | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-24 | P0 | Loop goal/endless selection, steering, scope/version changes, pause/stop/restart | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-25 | P0 | Native modal boundaries for confirmation/dialog cancellation | PASS | E PASS; K not run · other hosts: 3 BLOCKED |
| UI-26 | P2 | Large history, active four-stream fixture, repeated navigation over 1 hour | not run | E not run; K not run; L not run · other hosts: 3 BLOCKED |

## 5.22 Packaging, upgrades, and release integrity

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| PKG-01 | P0 | Clean native builds for Mac arm64/x64, Windows x64, Linux x64 | PASS | K PASS · other hosts: 3 BLOCKED |
| PKG-02 | P1 | Expected asset names | PASS | K PASS; U PASS · other hosts: 3 BLOCKED |
| PKG-03 | P0 | Real extracted app startup, not `electron .` | **FAIL** | K **FAIL** |
| PKG-04 | P0 | Packaged SQLite and PTY native modules | PASS | K PASS |
| PKG-05 | P0 | Companion CLI and context grant from packaged path | PASS | K PASS |
| PKG-06 | P0 | Mac deep/strict signature and extracted-resource tampering | PASS | K PASS; U PASS · other hosts: 1 BLOCKED |
| PKG-07 | P1 | macOS real first-open / quarantine, Dock/window/menu behavior | BLOCKED | K BLOCKED · other hosts: 3 BLOCKED |
| PKG-08 | P1 | Windows portable startup and process cleanup | not run |  · other hosts: 1 BLOCKED |
| PKG-09 | P1 | Linux AppImage first launch, execution bit, desktop libraries, secure storage | not run |  · other hosts: 1 BLOCKED |
| PKG-10 | P0 | Existing release v0.1.1/v0.1.2 profile → candidate upgrade | PASS | K PASS |
| PKG-11 | P0 | Upgrade with paused/active/uncertain workflows | PASS | K PASS |
| PKG-12 | P0 | Crash/power-loss/disk-full during vault write, migration, startup | PASS | K PASS |
| PKG-13 | P0 | Restore backup to new profile/host; older schema/unknown future schema | PASS | K PASS |
| PKG-14 | P1 | Replace app binary while data stays; uninstall/removal semantics | PASS | K PASS |
| PKG-15 | P0 | Release tag/context guards | not run | U not run |
| PKG-16 | P0 | Partial/missing/duplicate/extra assets, zero-byte/corrupt checksums | not run | U not run |
| PKG-17 | P0 | Parallel upload race, failed OS job, retry, asset mutation after verify | PASS | U PASS |
| PKG-18 | P0 | Next release identity after current 0.1.2 development head | not run | K not run |

## 5.23 Task records, service ownership, and event delivery

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| TASK-01 | P0 | Create a workflow with independent/dependent tasks; validate permitted transitions, missing dependencies, cycl… | **FAIL** | S **FAIL**; U PASS |
| TASK-02 | P0 | Bind multiple native sessions to one logical task and multiple turns to one session; retain provenance, preven… | PASS | P not run; S PASS |
| TASK-03 | P0 | Two service/coordinator instances open the same profile. Only the current owner performs recovery or dispatch;… | PASS | P PASS; S PASS |
| TASK-04 | P0 | A run finishes its model message while its child process still exists. Record submitted output, preserve the l… | not run | P not run; S not run |
| TASK-05 | P0 | Kill service during attempted dispatch and restart. Distinguish never-launched, known-active and unknown outco… | PASS | L not run; P PASS; S PASS |
| TASK-06 | P0 | Bind task context to a specification and shared revisions; reject missing required context and stale/foreign r… | PASS | S PASS |
| TASK-07 | P1 | Query tasks by project/workflow with pagination and concurrent changes; selected task refreshes independently,… | not run | E not run; S not run |
| TASK-08 | P0 | Event transaction commits versus rolls back: only committed ordered metadata advances the watermark. Gaps, dup… | PASS | E not run; S PASS |
| TASK-09 | P0 | Stream large concurrent runs; emitted state contains bounded scoped previews, not global plaintext history sna… | PASS | L not run; S PASS |
| TASK-10 | P0 | Delete a conversation with related context/session/attempt derivatives; preserve required tombstones and histo… | PASS | E not run; S PASS |
| TASK-11 | P1 | Service crashes or becomes unavailable while a form is pending; preserve last-known data with an error, retain… | not run | E not run; S not run |
| TASK-12 | P1 | Allocate task temp directory, database and port; restart before port handoff, occupy the port after handoff, a… | not run | P not run; S not run |
| TASK-13 | P0 | Invoke `task-context-bind` for a task in each lifecycle state, with current/stale revision, correct/foreign pr… | PASS | S PASS; U PASS |

## 5.24 Codex runtime qualification

| Case | Priority | Scenario (abridged) | Case result | Layer results |
| --- | --- | --- | --- | --- |
| CQ-01 | P0 | Invoke `runtime-qualify` without broker approval; cancel its native dialog; use untrusted/unconnected runtime,… | **FAIL** | E not run; N1 not run; P PASS; S PASS; U **FAIL** · other hosts: 1 n/a |
| CQ-02 | P0 | Exercise a native-subscription account, no account, API-key account, marker returned/missing, repeated fresh t… | PASS | E not run; N1 PASS; P PASS · other hosts: 1 n/a |
| CQ-03 | P0 | Run the direct read-only sandbox control and sentinel write with enforcing, broken, unavailable and misleading… | PASS | E not run; N1 PASS; P PASS · other hosts: 1 n/a |
| CQ-04 | P0 | Run direct workspace-write probes with inside success/outside denial, inside failure, outside success, skipped… | PASS | E not run; N1 PASS; P PASS · other hosts: 1 n/a |
| CQ-05 | P0 | Prepare the one-file encrypted reader fixture; let the runtime read successfully, skip the read, call another … | **FAIL** | E not run; N1 **FAIL**; P PASS; U PASS · other hosts: 1 n/a |
| CQ-06 | P0 | During qualification, emit command/file approvals, a request outside the current probe, delayed first streamed… | **FAIL** | E not run; N1 **FAIL**; P not run · other hosts: 1 not run |
| CQ-07 | P0 | Fail a probe, close the app during qualification, retain an owned descendant, fail process shutdown, or change… | PASS | E not run; N1 PASS; P PASS; S PASS · other hosts: 1 n/a |
| CQ-08 | P0 | Record valid qualification; separately alter each binding field, change only Codex `config.toml.projects`, cha… | PASS | E not run; N1 not run; S PASS · other hosts: 1 n/a |

## Journeys

| Journey | Layer results | Note |
| --- | --- | --- |
| J-01 | E-standin not run; N1 not run |  |
| J-02 | E-standin not run; N1 PASS | Live Claude→Codex handoff passed with the owner's sign-ins; reverse direction not run |
| J-03 | E not run; E-standin not run; N1 BLOCKED; S not run; U PASS | Four live pairings blocked: Claude Code permission prompts need the owner present |
| J-04 | E not run; E-standin not run; K not run; N1 not run; S PASS |  |
| J-05 | E not run; E-standin not run; N1 not run; S PASS |  |
| J-06 | E not run; E-standin not run; N1 not run; S PASS |  |
| J-07 | E not run; E-standin not run; K not run; N1 not run; S PASS |  |
| J-08 | E not run; E-standin not run; N1 not run; P PASS; S not run |  |
| J-09 | E not run; E-standin not run; N1 not run; S PASS |  |
| J-10 | E not run; E-standin not run; K not run; S PASS |  |
| J-11 | E-standin not run |  |
| J-12 | E-standin not run; K PASS | v0.1.1 and v0.1.2 tag-source profiles opened by the packaged candidate |
| J-13 | E not run; E-standin not run; N1 **NOT IMPL**; S PASS |  |
| J-14 | E not run; E-standin not run; S PASS |  |

## Boundary, mode, fault and performance rows

Rows recorded under plan §6 (boundaries and modes), §8 (fault matrix) and §12.7 (performance), which have no case ID of their own.

| ID | Layer results |
| --- | --- |
| 6.1-checks | U PASS; S PASS |
| 6.1-evaluation-preview | S not run |
| 6.1-goal-batch | U PASS; S PASS |
| 6.1-goal-priority | U PASS |
| 6.1-goal-text | U PASS; S PASS |
| 6.1-iteration-bounds | U PASS |
| 6.1-loop-bound-child-reset | S PASS |
| 6.1-monitoring | U PASS; S **FAIL** |
| 6.1-ordinary-check-authorization | U PASS; S PASS; P PASS |
| 6.1-required-checks | U PASS; S PASS; E not run |
| 6.1-rolling-allowance | U PASS; S **FAIL** |
| 6.1-timeline | U PASS; S PASS |
| 6.2-auto-accept | U PASS; S PASS; E not run |
| 6.2-check-execution | U PASS; S PASS; P PASS |
| 6.2-check-recipe | U PASS; S PASS; P PASS |
| 6.2-claude-terminal-modes | U PASS; S PASS |
| 6.2-codex-chat-presets | U PASS; S PASS |
| 6.2-codex-terminal-modes | U PASS; S PASS |
| 6.2-preparation-network | U PASS; S PASS; P not run |
| BND-6.1-active-role-count | S **FAIL** |
| BND-6.1-adaptive-membership-width | U PASS |
| BND-6.1-count-min-max-width | U PASS |
| BND-6.1-membership-identity-fallbacks | U PASS; S PASS |
| BND-6.1-participation-decision | U PASS; S PASS |
| BND-6.1-per-role-policy | U PASS; S PASS |
| BND-6.1-role-proposals | U PASS; S PASS |
| BND-6.3-product-benefit | N1 not run |
| BND-6.3-rule-correctness | U **FAIL** |
| FAULT-08-DEVICE-REVOKE | S PASS; L not run |
| FAULT-feature-disable | S **FAIL** |
| FAULT-pause-stop-wakeup | S PASS |
| FAULT-promotion-to-event | S **FAIL** |
| FAULT-publication-write-receipt | S PASS |
| FAULT-usage-cursor | S **FAIL** |
| MODE-6.2-ADVANCED-competing-implementations | S PASS |
| MODE-6.2-ADVANCED-independent-proposals | S PASS |
| MODE-6.2-ADVANCED-independent-test-design | S PASS |
| MODE-6.2-ADVANCED-pair-debugging | S PASS |
| PERF-12.7-accessibility | E BLOCKED |
| PERF-12.7-fixture-renderer-update | E PASS |
| PERF-12.7-ordinary-ui-response | E not run |
| PERF-12.7-resource-growth | L not run |
| S6.1-HANDOFF-SNAPSHOT | U PASS; S **FAIL** |

## Command groups

| Group | Commands | Mapped case results |
| --- | --- | --- |
| 01. Vault and application state | `state`, `unlock` | 1 **FAIL**, 11 PASS |
| 02. Theme and saved navigation | `theme`, `navigation-save`, `navigation-query` | 6 PASS, 1 BLOCKED, 1 not run |
| 03. Installation discovery, trust and selection | `discover`, `trust-installation`, `select-runtime` | 3 PASS, 1 BLOCKED, 2 not run |
| 04. Provider connection, account and model observation | `runtime-connect`, `runtime-models`, `runtime-account` | 7 PASS, 1 not run |
| 05. Runtime qualification and evidence query | `runtime-qualify`, `runtime-qualification-query` | 3 **FAIL**, 10 PASS |
| 06. Reserved login command rejection | `runtime-login` | 3 PASS |
| 07. Acquisition and installation lifecycle | `check-updates`, `lifecycle-preview`, `lifecycle-apply`, `lifecycle-cancel`, `lifecycle-reconcile`, `lifecycle-retry-preview` | 10 PASS, 3 BLOCKED, 1 not run |
| 08. Native application and verified external targets | `open-application`, `open-docs`, `show-download` | 1 PASS, 2 BLOCKED, 1 not run |
| 09. Execution and transcript settings | `auto-accept-set`, `claude-transcript-read-set`, `claude-structured-route-set` | 7 PASS |
| 10. Native configuration read, preview and apply | `configuration-read`, `configuration-preview`, `configuration-apply` | 1 **FAIL**, 6 PASS, 4 not run |
| 11. Read-only companion context grant | `context-enable` | 1 **FAIL**, 8 PASS |
| 12. Local projects, trust, relinking and opening | `project-add`, `project-trust`, `project-relink`, `project-open`, `project-copy-path` | 7 PASS |
| 13. Approved native project discovery | `project-sync-enable`, `project-sync-refresh` | 7 PASS |
| 14. Codex registry synchronization and ordering | `codex-project-sync-enable`, `codex-project-sync-pause`, `codex-project-sync-refresh`, `codex-project-rename`, `codex-project-move` | 10 PASS, 1 BLOCKED |
| 15. Directional synchronization and conflict resolution | `sync-field-push`, `synchronization-query`, `sync-field-intent`, `sync-field-resolve` | 4 PASS |
| 16. Native link state and local root mapping | `native-link-state`, `native-root-map` | 4 PASS |
| 17. Conversation creation and managed run start | `conversation-add`, `run-start` | 16 PASS |
| 18. Run control, uncertainty and request approval | `run-interrupt`, `run-reconcile`, `approval-decide` | 1 **FAIL**, 7 PASS, 1 not run |
| 19. Native terminal lifecycle, including login flow | `terminal-open`, `terminal-input`, `terminal-resize`, `terminal-close` | 11 PASS |
| 20. Local history search, pages and messages | `history-search`, `history-message`, `history-page`, `history-conversations` | 2 **FAIL**, 4 PASS |
| 21. Local history ingestion and deletion | `history-import`, `history-delete` | 10 PASS |
| 22. Native history source approval and reconciliation | `native-history-approve`, `native-history-reconcile`, `native-history-pause` | 9 PASS |
| 23. Scoped snapshots and ordered event pages | `scope-snapshot`, `scope-events` | 5 PASS, 1 not run |
| 24. Reviewed handoff snapshot and export | `handoff-preview`, `handoff-export` | 2 **FAIL**, 2 PASS |
| 25. Assisted handoff preparation, open, import and state | `assisted-handoff-prepare`, `assisted-handoff-open`, `assisted-handoff-import`, `assisted-handoff-query` | 1 **FAIL**, 6 PASS |
| 26. Provider quota refresh and period token budgets | `provider-allowance-refresh`, `provider-budget-save` | 9 PASS, 3 not run |
| 27. Per-project token and wall-time reporting thresholds | `usage-budget-query`, `usage-budget-save` | 1 PASS, 2 not run |
| 28. Logical workflow and task creation, transition and dispatch | `workflow-create`, `task-create`, `task-transition`, `task-run` | 1 **FAIL**, 11 PASS, 1 not run |
| 29. Coordination list/page and task inspection | `coordination-query`, `coordination-page`, `task-inspect` | 3 PASS, 1 not run |
| 30. Frozen task input inspection and context binding | `task-inputs-inspect`, `task-context-bind` | 6 PASS |
| 31. Shared revisions and Build and review specification updates | `shared-revision-publish`, `builder-reviewer-specification-publish`, `builder-reviewer-specification-restart` | 7 PASS |
| 32. Build and review creation, advancement and inspection | `builder-reviewer-query`, `builder-reviewer-inspect`, `builder-reviewer-create`, `builder-reviewer-advance` | 12 PASS, 1 not run |
| 33. Build and review checks and finding dispositions | `builder-reviewer-checks-preview`, `builder-reviewer-check-apply`, `workflow-finding-decide` | 15 PASS |
| 34. Build and review final acceptance and cancellation | `builder-reviewer-accept`, `builder-reviewer-cancel` | 1 **FAIL**, 4 PASS, 1 BLOCKED |
| 35. Claude native-step opening and handback | `claude-step-open`, `claude-step-return` | 10 PASS |
| 36. Candidate diff and rollout/readiness queries | `candidate-diff-query`, `round-2-features-query`, `workflow-readiness-query` | 13 PASS |
| 37. Environment detection, selection and instance inspection | `environment-detect`, `environment-selection-create`, `environment-instances-query`, `environment-instance-inspect` | 9 PASS, 1 not run |
| 38. Bounded check authorization reuse and revocation | `check-authorization-reuse-preview`, `check-authorization-revoke` | 4 PASS |
| 39. Check execution inspection, reconciliation and cleanup | `check-execution-inspect`, `check-executions-query`, `check-execution-reconcile`, `check-cleanup-retry` | 9 PASS, 1 not run |
| 40. Managed workspace creation and removal | `managed-workspaces-query`, `workspace-create-preview`, `workspace-remove-preview`, `workspace-plan-apply` | 3 PASS, 2 not run |
| 41. Parallel specialist creation, dispatch and submission | `parallel-create`, `parallel-query`, `parallel-dispatch`, `parallel-submit` | 2 **FAIL**, 2 PASS, 2 not run |
| 42. Parallel integration preview and apply | `parallel-integration-preview`, `parallel-integration-apply` | 5 PASS |
| 43. Parallel checks, acceptance and cancellation | `parallel-checks-preview`, `parallel-check-apply`, `parallel-accept`, `parallel-cancel` | 19 PASS |
| 44. Optional feature gates and advanced workflow start | `optional-feature-set`, `advanced-query`, `advanced-create`, `advanced-dispatch` | 6 PASS |
| 45. Advanced frozen participant submissions | `advanced-freeze`, `advanced-capture`, `advanced-submissions` | 9 PASS |
| 46. Independent test candidate and advanced process verification | `advanced-test-candidate-capture`, `advanced-check-preview`, `advanced-check-apply`, `advanced-bind-verification` | 12 PASS |
| 47. Advanced evaluation, selection, owner review and acceptance | `advanced-evaluate`, `advanced-select`, `advanced-review-preview`, `advanced-review-confirm`, `advanced-accept` | 5 PASS |
| 48. Debugging checkpoint and measured routing presets | `advanced-checkpoint`, `routing-preset-save`, `routing-measure` | 5 PASS |
| 49. Replication device, mapping and owner plans | `replication-query`, `replication-device-preview`, `replication-mapping-preview`, `replication-owner-preview`, `replication-plan-apply` | 4 PASS |
| 50. Replication staging and encrypted export chunks | `replication-stage-preview`, `replication-export-preview`, `replication-chunk` | 2 **FAIL**, 3 PASS |
| 51. Replication import assembly and completion | `replication-import-begin`, `replication-import-chunk`, `replication-import-complete` | 2 **FAIL**, 5 PASS |
| 52. Replication conflicts, deletion and revocation | `replication-conflict-preview`, `replication-conflict-resolve`, `replication-delete`, `replication-device-revoke` | 2 **FAIL**, 3 PASS |
| 53. Coordinator conversations and goal routing | `orchestration-query`, `orchestration-conversation-create`, `orchestration-message` | 1 **FAIL**, 3 PASS |
| 54. Coordinator N-member settings, custom roles and policy | `orchestration-group-set`, `orchestration-member-release`, `orchestration-roster-release`, `orchestration-policy-set`, `orchestration-role-define` | 1 **FAIL**, 8 PASS |
| 55. Coordinator control, round restart and owner branch | `orchestration-control`, `orchestration-round-restart`, `orchestration-branch-choose` | 1 **FAIL**, 4 PASS, 2 not run |
| 56. Coordinator checks, conflicts, findings and repair | `orchestration-checks-set`, `orchestration-checks-preview`, `orchestration-check-apply`, `orchestration-conflict-resolve`, `orchestration-finding-decide`, `orchestration-repair` | 6 PASS, 3 not run |
| 57. Coordinator owner acceptance and folder application | `orchestration-accept`, `orchestration-apply` | 2 **FAIL**, 1 PASS, 2 not run |
| 58. Loop feature gate, inspection, history and initial authority | `loop-feature-set`, `loop-query`, `loop-inspect`, `loop-timeline`, `loop-create`, `loop-start` | 3 **FAIL**, 8 PASS |
| 59. Loop goals, policy, owner overrides and steering | `loop-goals-update`, `loop-policy-update`, `loop-override-set`, `loop-override-release`, `loop-message` | 1 **FAIL**, 13 PASS, 2 not run |
| 60. Loop control, checkpoint export and publication | `loop-control`, `loop-checkpoint-export`, `loop-publication-preview`, `loop-publication-apply`, `loop-publication-reconcile` | 2 **FAIL**, 9 PASS, 1 not run |
