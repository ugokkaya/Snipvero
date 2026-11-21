import { Fragment, type ReactNode } from "react";
import { t, type MessageKey, type Params } from "./i18n";

/**
 * A message with markup inside it: `{name}` in the message is replaced by `slots.name`, the
 * rest is text. Lets a translation place a `<kbd>` or `<strong>` where its grammar needs it.
 */
export function richMessage(
  key: MessageKey,
  slots: Record<string, ReactNode>,
  params?: Params,
): ReactNode {
  const parts = t(key, params).split(/\{(\w+)\}/);
  return parts.map((part, index) =>
    index % 2 === 0 ? part : <Fragment key={index}>{slots[part] ?? `{${part}}`}</Fragment>,
  );
}
