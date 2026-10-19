import type {
  AppState,
  Installation,
  LifecyclePlan,
} from "../../../../packages/domain/types";
import type { Command } from "../../../../packages/domain/commands";
import { ActionButton } from "../components/action-button";
import { Badge } from "../components/atlas";
import { ProviderUsage } from "../components/allowance";

type Props = {
  state: AppState;
  act: (command: Command) => Promise<any>;
  connect: (installation: Installation) => Promise<void>;
  preview: (
    installation: Installation | null,
    appId: string,
    action: "download" | "install" | "update",
  ) => Promise<void>;
  setPlan: (plan: LifecyclePlan | null) => void;
};

export function ApplicationsScreen({
  state,
  act,
  connect,
  preview,
  setPlan,
}: Props) {
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR TOOLBOX</div>
          <h1>Applications</h1>
          <p>Native tools. One place to keep them ready.</p>
        </div>
        <div className="actions">
          <ActionButton onClick={() => void act({ type: "select-runtime" })}>
            Locate a runtime
          </ActionButton>
          <ActionButton
            disabled={state.testProfile}
            onClick={() => void act({ type: "discover" })}
          >
            ↻ Discover
          </ActionButton>
        </div>
      </div>
      {state.testProfile && (
        <div className="info-strip">
          <span className="status-dot notice" />
          <div>
            <strong>This is a test profile.</strong>
            <span>
              {" "}
              Topsl doesn't search for applications here, so it lists only the
              ones the test set up. Your usual profile still finds what's
              installed.
            </span>
          </div>
        </div>
      )}
      <div className="info-strip">
        <span className="status-dot" />
        <div>
          <strong>You approve every Topsl update.</strong>
          <span>
            {" "}
            Metadata checks run at most daily. Native automatic updates keep
            their existing settings.
          </span>
        </div>
      </div>
      <ProviderUsage state={state} />
      <div className="eyebrow">RUNTIMES AND APPLICATIONS</div>
      <div className="application-grid application-catalog">
        {state.applications.map((app) => {
          const installations = state.installations.filter(
            (i) => i.appId === app.id,
          );
          const supported = app.platforms.includes(
            state.platform.split("/")[0],
          );
          return (
            <article className="application-card" key={app.id}>
              <div className="card-title">
                <div className={"app-icon " + app.provider}>
                  {app.provider === "codex" ? "◎" : "✳"}
                </div>
                <div>
                  <h2>{app.name}</h2>
                  <span className="muted tiny">
                    {app.kind === "cli" ? "CLI RUNTIME" : "DESKTOP APPLICATION"}
                  </span>
                </div>
                <Badge tone={installations.length ? "good" : ""}>
                  {installations.length
                    ? "Installed"
                    : !supported
                      ? "Native app unavailable"
                      : state.testProfile
                        ? "Not searched"
                        : "Not found"}
                </Badge>
              </div>
              <p className="description">{app.description}</p>
              {installations.length ? (
                installations.map((i) => {
                  const check = state.checks.find(
                    (c) => c.installationId === i.id,
                  );
                  return (
                    <div className="installation" key={i.id}>
                      <div className="installation-heading">
                        <strong>{i.version ?? "Version not verified"}</strong>
                        <Badge
                          tone={check?.status === "available" ? "warm" : ""}
                        >
                          {check?.status === "available"
                            ? `${check.release?.version} available`
                            : i.compatibility === "compatible"
                              ? "Protocol connected"
                              : i.compatibility}
                        </Badge>
                      </div>
                      <dl>
                        <div>
                          <dt>Owner / channel</dt>
                          <dd>
                            {i.owner} / {i.channel}
                          </dd>
                        </div>
                        <div>
                          <dt>Native auto-updates</dt>
                          <dd>
                            {i.nativeAutoUpdates === "unknown"
                              ? "Unknown · owner controlled"
                              : i.nativeAutoUpdates}
                          </dd>
                        </div>
                        <div>
                          <dt>Running state</dt>
                          <dd>
                            {i.runningPids == null
                              ? "Unknown"
                              : i.runningPids.length
                                ? `${i.runningPids.length} process(es)`
                                : "Not observed running"}
                          </dd>
                        </div>
                        <div>
                          <dt>Topsl trust</dt>
                          <dd>
                            {i.trusted
                              ? "Approved executable"
                              : "Review before execution"}
                          </dd>
                        </div>
                      </dl>
                      <code className="path" title={i.realPath}>
                        {i.path}
                      </code>
                      <div className="actions wrap">
                        {!i.trusted && (
                          <ActionButton
                            onClick={() =>
                              void act({
                                type: "trust-installation",
                                id: i.id,
                              })
                            }
                          >
                            Trust executable
                          </ActionButton>
                        )}
                        {app.id === "openai.codex-cli" && i.trusted && (
                          <ActionButton onClick={() => connect(i)}>
                            Connect / test
                          </ActionButton>
                        )}
                        <ActionButton
                          onClick={() =>
                            void act({
                              type: "check-updates",
                              id: i.id,
                            })
                          }
                        >
                          Check for updates
                        </ActionButton>
                        <ActionButton
                          onClick={() => preview(i, app.id, "update")}
                        >
                          Update…
                        </ActionButton>
                        {app.kind === "desktop" && (
                          <ActionButton
                            onClick={() =>
                              void act({
                                type: "open-application",
                                id: i.id,
                              })
                            }
                          >
                            Open
                          </ActionButton>
                        )}
                      </div>
                      {check && (
                        <p className="check-detail">
                          {check.detail}
                          <br />
                          Checked {new Date(check.checkedAt).toLocaleString()} ·
                          next {new Date(check.nextCheckAt).toLocaleString()}
                        </p>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="not-installed">
                  <span>Ready when you are.</span>
                  <small>
                    Installer availability depends on your OS and architecture.
                  </small>
                </div>
              )}
              <div className="card-footer">
                <div className="actions">
                  <ActionButton
                    className={!installations.length ? "primary" : ""}
                    disabled={!supported}
                    onClick={() => preview(null, app.id, "download")}
                  >
                    Download
                  </ActionButton>
                  {!installations.length && (
                    <ActionButton
                      disabled={!supported}
                      onClick={() => preview(null, app.id, "install")}
                    >
                      Install…
                    </ActionButton>
                  )}
                </div>
                <ActionButton
                  className="text-button"
                  onClick={() =>
                    void act({
                      type: "open-docs",
                      appId: app.id,
                      kind: "releaseNotes",
                    })
                  }
                >
                  Release notes ↗
                </ActionButton>
              </div>
              <ActionButton
                className="text-button download-link"
                onClick={() =>
                  void act({
                    type: "open-docs",
                    appId: app.id,
                    kind: "website",
                  })
                }
              >
                Official download / native installer ↗
              </ActionButton>
            </article>
          );
        })}
      </div>
      <section className="jobs">
        <div className="section-heading">
          <h2>Operations</h2>
          <span className="muted tiny">DURABLE LOCAL JOURNAL</span>
        </div>
        {!state.jobs.length ? (
          <div className="empty-row">
            No downloads or updates yet. Approved operations will appear here.
          </div>
        ) : (
          state.jobs.map((j) => (
            <div key={j.id} className="job">
              <div>
                <strong>Operation {j.id.slice(0, 8)}</strong>{" "}
                <Badge>{j.state}</Badge>
                <p>{j.detail}</p>
                {j.bytes > 0 && (
                  <>
                    <progress
                      value={j.bytes}
                      max={j.total ?? Math.max(j.bytes * 1.1, 1)}
                    />
                    <small>
                      {" "}
                      {(j.bytes / 1e6).toFixed(1)} MB
                      {j.total ? ` / ${(j.total / 1e6).toFixed(1)} MB` : ""}
                    </small>
                  </>
                )}
                {j.actualVersion && (
                  <small>
                    Installed {j.actualVersion} · compatibility evaluated
                    separately
                  </small>
                )}
              </div>
              <div className="actions">
                {j.acquiredPath && (
                  <ActionButton
                    onClick={() =>
                      void act({ type: "show-download", id: j.id })
                    }
                  >
                    Show download
                  </ActionButton>
                )}
                {["queued", "waiting-for-idle", "downloading"].includes(
                  j.state,
                ) && (
                  <ActionButton
                    onClick={() =>
                      void act({ type: "lifecycle-cancel", id: j.id })
                    }
                  >
                    Cancel
                  </ActionButton>
                )}
                {["failed", "cancelled", "unchanged"].includes(j.state) && (
                  <ActionButton
                    onClick={async () => {
                      const value = await act({
                        type: "lifecycle-retry-preview",
                        id: j.id,
                      });
                      if (value) setPlan(value);
                    }}
                  >
                    Review retry…
                  </ActionButton>
                )}
                {["uncertain", "awaiting-native", "waiting-for-idle"].includes(
                  j.state,
                ) && (
                  <ActionButton
                    onClick={() =>
                      void act({
                        type: "lifecycle-reconcile",
                        id: j.id,
                      })
                    }
                  >
                    Reconcile
                  </ActionButton>
                )}
              </div>
            </div>
          ))
        )}
      </section>
    </>
  );
}
