import type { ReactNode } from "react";
import topsail from "../../../../assets/brand/topsl.svg";

export function Brand({ large = false }: { large?: boolean }) {
  return (
    <div className={`brand${large ? " large" : ""}`}>
      <img className="brand-sail" src={topsail} alt="" />
      <span>
        Topsl<small>NAVIGATOR’S ATLAS</small>
      </span>
    </div>
  );
}

const paths: Record<string, ReactNode> = {
  projects: (
    <>
      <path d="M3 6h6l2 2h10v12H3z" />
      <path d="M3 6V4h7l2 2" />
    </>
  ),
  overview: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5zM12 1v2m0 18v2M1 12h2m18 0h2" />
    </>
  ),
  sessions: (
    <>
      <path d="M4 4h16v12H9l-5 4z" />
      <path d="m8 8 3 2-3 2m5 0h3" />
    </>
  ),
  coordinator: (
    <>
      <circle cx="12" cy="5" r="3" />
      <circle cx="5" cy="18" r="3" />
      <circle cx="19" cy="18" r="3" />
      <path d="M12 8v4H5v3m7-3h7v3" />
    </>
  ),
  tasks: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="m7 8 1 1 2-2m3 1h4m-10 6 1 1 2-2m3 1h4" />
    </>
  ),
  changes: (
    <>
      <path d="M8 3v12a4 4 0 0 0 4 4h5M8 8h5a4 4 0 0 0 4-4V3" />
      <circle cx="8" cy="3" r="2" />
      <circle cx="8" cy="19" r="2" />
      <circle cx="17" cy="19" r="2" />
      <circle cx="17" cy="3" r="2" />
    </>
  ),
  context: (
    <>
      <path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1zM12 5v15" />
    </>
  ),
  history: (
    <>
      <path d="M4 8a9 9 0 1 1-1 7M4 3v5h5M12 7v5l3 2" />
    </>
  ),
  providers: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="8" cy="6" r="2" />
      <circle cx="16" cy="12" r="2" />
      <circle cx="10" cy="18" r="2" />
    </>
  ),
  arrow: (
    <>
      <path d="M4 12h16m-6-6 6 6-6 6" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
};
/** Destinations drawn with another destination's figure. */
const aliases: Record<string, string> = {
  "all-sessions": "history",
  "project-settings": "settings",
  advanced: "tasks",
  imports: "history",
};

export function AtlasIcon({
  name,
  className = "",
}: {
  name: string;
  className?: string;
}) {
  return (
    <svg
      className={`atlas-icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[aliases[name] ?? name] ?? paths.overview}
    </svg>
  );
}

export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
