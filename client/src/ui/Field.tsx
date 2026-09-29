import { createContext, useContext, useId, type ReactNode } from 'react';
import { cn } from '../lib/cn';

interface FieldCtx {
  id: string;
  describedBy?: string;
  invalid: boolean;
}
const FieldContext = createContext<FieldCtx | null>(null);

/** Used by Input/Textarea/Select to pick up the Field's id + aria wiring automatically. */
export function useFieldControl() {
  return useContext(FieldContext);
}

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Content shown on the right of the label row (e.g. a "Forgot?" link or counter). */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
  /** Override the generated control id. */
  id?: string;
}

/** Label + control + hint/error. Controls inside get id/aria-describedby/aria-invalid automatically. */
export function Field({ label, hint, error, required, aside, className, children, id }: FieldProps) {
  const auto = useId();
  const controlId = id ?? `f${auto.replace(/:/g, '')}`;
  const msgId = `${controlId}-msg`;
  const hasMsg = !!(error || hint);
  return (
    <FieldContext.Provider value={{ id: controlId, describedBy: hasMsg ? msgId : undefined, invalid: !!error }}>
      <div className={cn('flex flex-col gap-1.5', className)}>
        {(label || aside) && (
          <div className="flex items-baseline justify-between gap-2">
            {label && (
              <label htmlFor={controlId} className="text-[13px] font-semibold text-fg">
                {label}
                {required && <span className="ml-0.5 text-danger">*</span>}
              </label>
            )}
            {aside && <div className="text-xs text-muted">{aside}</div>}
          </div>
        )}
        {children}
        {hasMsg && (
          <p id={msgId} className={cn('text-xs', error ? 'font-medium text-danger' : 'text-muted')} role={error ? 'alert' : undefined}>
            {error || hint}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}
