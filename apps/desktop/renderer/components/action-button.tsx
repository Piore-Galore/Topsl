import {
  createContext,
  useContext,
  useId,
  type ButtonHTMLAttributes,
  type MutableRefObject,
} from "react";
export const ActionContext = createContext<{
  pending: Set<string>;
  active: MutableRefObject<string | null>;
}>({ pending: new Set(), active: { current: null } });
/** Pending state belongs to the initiating control. Existing validity/trust
 * disabled conditions remain React-owned and cannot be overwritten by effects. */
export function ActionButton({
  onClick,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const id = useId(),
    context = useContext(ActionContext);
  return (
    <button
      {...props}
      disabled={disabled || context.pending.has(id)}
      onClick={(event) => {
        context.active.current = id;
        try {
          onClick?.(event);
        } finally {
          queueMicrotask(() => {
            if (context.active.current === id) context.active.current = null;
          });
        }
      }}
    />
  );
}
