import type { ReactNode } from "react";

export type Tone = "ok" | "warning" | "neutral";

/** One row of the main window's status list. */
export function StatusRow(props: {
  icon: ReactNode;
  title: string;
  value: string;
  tone: Tone;
  /** A control after the value, such as a button. */
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="status-row">
      <span className="status-icon">{props.icon}</span>
      <div className="status-body">
        <div className="status-line">
          <span className="status-title">{props.title}</span>
          <span className="status-aside">
            <span className="status-value" data-tone={props.tone}>
              <span className="status-dot" aria-hidden="true" />
              {props.value}
            </span>
            {props.aside}
          </span>
        </div>
        {props.children}
      </div>
    </li>
  );
}
