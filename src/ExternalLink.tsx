import type { ReactNode } from "react";
import { openLink, type Link } from "./ipc";

interface Props {
  link: Link;
  /** Shown as the link target (hover, accessibility); Rust decides what actually opens. */
  href: string;
  className?: string;
  children: ReactNode;
}

/** A link that Rust opens in the default browser; the web view itself never navigates away. */
export function ExternalLink({ link, href, className, children }: Props) {
  return (
    <a
      href={href}
      className={className}
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault();
        void openLink(link);
      }}
    >
      {children}
    </a>
  );
}
