# Round 2 phase 5 — scoped UI and guided workflows

Status: local R2-5 implementation, the combined R2-3/R2-4 renderer integration, deterministic UI acceptance, and final visual inspection are complete as of October 15, 2026. Full application, native provider, clean-export, remote CI, and packaged-platform qualification remain separate evidence categories in [Round 2 execution](Round_2_Execution.md) and [phase 6](Round_2_Phase_6.md). These fixtures do not qualify a live provider route or packaged platform.

## Implemented increment

- One shared snapshot/replay subscription owner per selected project. Subscription precedes snapshot capture; durable scoped replay closes the boundary, including missed notices and restored vault epochs. Scoped request generations, committed sequence, request order, and retired epochs prevent older responses from replacing accepted views. Sequence numbers from different epochs are never compared.
- Refresh errors retain the last successful data and expose source, revision, observation time, status, and an explicit read retry. Automatic retries are bounded and only repeat reads. Focus, online, pageshow, and visibility resume reconcile stored state without replaying a model turn, check, or destructive action.
- Project, task, workflow, transcript, pending-operation, error, model-selection, and inspection fences prevent late updates from following the user into another scope. Task inspection pending state belongs to each task's latest request, so switching tasks cannot leave a completed request permanently disabled or allow an older request to clear a newer pending read. Context attachments and native chat input clear when their selected scope changes.
- Goal → Team → Environment → Scope → Review setup replaces argument JSON with ordinary controls. Native model intent is preserved explicitly; supported effort controls come only from reported metadata. Canonical service role readiness and rollout gates control coordinated capture/dispatch. Trusted executable selection alone never enables Start.
- Save draft, capture coordinated inputs, capture for assisted handoff, prepare exported handoff, open native route, import external result, run checks, and final acceptance remain separate actions. Assisted import retains user-supplied provenance and does not manufacture provider acknowledgement or automatic acceptance.
- Drafts are revisioned encrypted Store documents scoped by project and optional workflow. New workflow setup and requirements-revision forms can save their own drafts. They never overwrite immutable specifications or active attempt inputs. Concurrent stale draft updates fail visibly.
- Detected environment suggestions select exact Node/npm script commands and bind their immutable selection identity to the check definition. Preparation is deferred to native approval of the exact check plan and recipe. The UI states the selected profile's actual isolation limits.
- Candidate inspection renders bounded before/after excerpts from protected immutable bytes, identifies revisions, binary limitations and omitted lines, and selects path-specific/historical finding evidence. Recorded finding decisions retain rationale and candidate links. A new candidate keeps earlier evidence historical.
- Check inspection shows command, environment, eligibility, protected redacted log, truncation, and independent cleanup state. Lifecycle reconciliation and cleanup retry are separately labelled and cannot rerun inference or a check.
- Synchronization has six separate evidence dimensions. Registry readback does not verify native presentation. Requested and reported model/effort, native thread/provider session identities, instruction source provenance, and source freshness remain distinct. Missing usage displays unknown rather than a measured zero.

## Initial local evidence

Commands run on the local Apple silicon host on October 15, 2026:

```text
npm run typecheck
npm test -- tests/scoped-ui.test.ts tests/workflow-drafts.test.ts
node scripts/round2-ui-test.mjs
```

The focused suite passed 8 tests. The isolated Electron renderer harness passed keyboard draft setup, project draft separation, a blocked coordinated route with explicit assisted capture, reverse same-project response arrival, retained-data refresh failure, lower-sequence vault epoch recovery, finding navigation and recorded rejection rationale, protected logs, lifecycle reconciliation, cleanup without rerun, compact width, 150% zoom, reduced motion, and Unicode names/paths. It asserts that no provider dispatch command was issued. The harness runs the production renderer components with declared fixture transport; it does not connect a real runtime or native account.

Screenshots are generated under `test-results/round2-ui/`:

- `guided-normal.png`
- `guided-compact.png`
- `guided-enlarged.png`
- `retained-data-error.png`
- `finding-check-evidence.png`
- `finding-check-detail.png`

Normal and compact captures were visually checked for readable labels and retained-data errors. Compact project tabs use two columns to avoid splitting the synchronization label inside a word. Enlarged capture uses Electron's native screenshot path because a full-page Playwright capture at native zoom cropped the image.

## Final integration follow-up — October 15, 2026

The final integration adds exact-hash new-output approval/rejection, separately confirmed narrow capture of previously withheld output paths, bounded raster preview, and affirmative manual binary verification. A binary receipt requires the user to attest that these exact bytes passed verification and describe the successful result. Text alone cannot discharge that gate. Each review first presents a protected expiring plan, then requests native confirmation. Cancelling native confirmation retains the proposal and does not fabricate a receipt. Narrow capture creates a new candidate; actual content approval, fresh review, and fresh checks remain required.

Check inspection now separates environment lifecycle, preparation failure category, observed tool versions, dependency identity, protected preparation logs, test output, eligibility, and cleanup. It discloses actual filesystem/network limitations. Detected recipes offer offline preparation and an explicit registry preparation choice; neither executes during detection. No registry installation was run for UI validation. See [phase 4](Round_2_Phase_4.md).

Candidate manifests initially render 100 paths and support filtering and explicit expansion. Artifact review lists are bounded to 25 paths per group. Context inspection distinguishes initial text, optional omissions, additional retrieval requirements, acknowledgements, and bounded returned/denied retrieval receipts. Returned bytes do not establish comprehension. See [phase 3](Round_2_Phase_3.md).

Final commands actually run on the local Apple silicon host:

```text
npm run typecheck
npm test -- tests/scoped-ui.test.ts tests/workflow-drafts.test.ts
node scripts/round2-ui-test.mjs
```

Typecheck and 9 focused tests passed. The final isolated Electron harness passed 15 declared journeys, including a previous-project delayed error, the new artifact/recapture workflow, preparation failure logs, context retrieval feedback, bounded large manifests, Paper/Night/System themes, and keyboard focus. An intermittent asynchronous plan-heading focus race was reproduced during final validation and fixed by focusing after React commits the plan. The full application desktop smoke then exposed a superseded task-read cleanup bug: switching A → B could leave A disabled indefinitely. Per-task request tokens fixed cleanup while retaining scope, selected-task, and observation fences. The rebuilt full desktop smoke passed, and a new isolated journey verifies late A rejection/cleanup plus overlapping same-task reads. The final harness passed after both fixes and asserts that no inference dispatch occurred. Native Cancel and approval responses in this harness are explicit fixture responses, not physical interaction with an OS approval dialog. Full desktop evidence remains in the [execution record](Round_2_Execution.md) and [final desktop log](round-2-evidence/r2-final-validation/desktop.txt).

Thirty sequential selected-scope update samples were measured on macOS/Darwin 27.0.0, arm64 Apple M5, Electron 44.4.5 / Chromium 152.0.7977.130. The fixture had two available projects, one selected project/workflow, and a 1,004-path manifest with 100 paths rendered initially. Measurement ran from a fixture metadata commit/control event through the production renderer DOM update and two animation frames over local Electron IPC. It excludes inference/network and is not a production service latency guarantee. The final run, concurrent with other local validation, measured p50 **132 ms**, p95 **132 ms**, and maximum **132 ms**, meeting the proposed 250 ms p95 target for this declared workload. Raw samples and runtime/host metadata are retained in [the latency record](round-2-evidence/phase5-ui-latency-2026-10-15.json).

Final screenshots are regenerated under `test-results/round2-ui/` and archived in [the dated UI evidence directory](round-2-evidence/phase5-ui-2026-10-15/). In addition to the initial filenames, the harness produces `artifact-approval-plan.png`, `artifact-approval-compact.png`, `candidate-recapture.png`, `artifact-night.png`, and `task-inspection-recovery.png`. Normal, compact, enlarged, retained-error, preparation/check evidence, approval-plan, recapture, Night, and task recovery captures were visually inspected. Hashes and paths wrap within compact layouts; enlarged controls remain usable. The approval screenshots show the renderer's concrete review plan, not an OS native dialog.

## Acceptance traceability and validation boundary

| Gate     | Final local evidence                                                                                            | Separate qualification boundary                                           |
| -------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| R2-AT-31 | Pure sequence/request fences and reverse-response ordering in the actual renderer                               | Native/provider/platform execution remains separate                       |
| R2-AT-32 | Encrypted project/workflow drafts, rapid project switching, task pending recovery, and delayed previous-project error rejection | Broader full application journeys are recorded separately                 |
| R2-AT-33 | Snapshot/replay, bounded read retry, restored epoch, retained data, and explicit recovery                       | Service restart and delivery qualification remain separate                |
| R2-AT-34 | Canonical readiness, drafts, explicit assisted capture, environment selection, exact artifact review/recapture  | Live coordinated and assisted provider routes need their own acceptance   |
| R2-AT-35 | Missing usage remains unknown; requested/reported intent, supported metadata, and source freshness are distinct | Runtime-specific acceptance is recorded in [phase 2](Round_2_Phase_2.md)  |
| R2-AT-36 | Keyboard setup/finding/plan focus/recovery; compact/zoom/reduced motion; Unicode paths; Paper/Night/System      | Physical native dialog interaction and packaged platforms remain separate |

The UI integration work listed in the initial increment is complete. This phase document is implementation and local fixture/visual evidence, not a green capability badge. The [reviewed plan](Topsl_Round_2_Improvement_Plan_Reviewed.md) and [Round 2 execution record](Round_2_Execution.md) retain the independent live-provider, delivery, and release gates.
