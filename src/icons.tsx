import type { ReactNode } from "react";

// Line icons on a 16-unit grid, drawn like the overlay toolbar's (`.icon` in App.css).
const icon = (path: ReactNode, size = 16) => (
  <svg className="icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
    {path}
  </svg>
);

/** The app icon's corner marks. */
export const CaptureIcon = ({ size }: { size?: number }) =>
  icon(<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />, size);

export const AnnotateIcon = () =>
  icon(
    <>
      <path d="M2.5 13.5 9 7M5.5 7H9v3.5" />
      <rect x="9.5" y="2.5" width="4" height="4" rx="0.5" />
    </>,
  );

export const ExportIcon = () =>
  icon(<path d="M8 2.5v7.5M5 7l3 3 3-3M3 11.5v1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1" />);

export const MenuBarIcon = () =>
  icon(
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 5.5h12" />
    </>,
  );

export const ShieldIcon = () =>
  icon(<path d="M8 2 3 4v3.5c0 3 2.1 5.4 5 6.5 2.9-1.1 5-3.5 5-6.5V4z" />);

/** A circular arrow around a downward arrow: updates. */
export const UpdateIcon = () =>
  icon(<path d="M13.5 8A5.5 5.5 0 1 1 11.5 3.8M13.5 2.5v2.5H11M8 5.5v5M6 8.5l2 2 2-2" />);

export const KeyboardIcon = () =>
  icon(
    <>
      <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
      <path d="M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 9.5h6" />
    </>,
  );

export const InfoIcon = () =>
  icon(
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.5v3M8 5.5h.01" />
    </>,
  );

export const GitHubIcon = () => (
  <svg className="icon icon-filled" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);
