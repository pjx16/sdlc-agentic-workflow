'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { getIn, type FormValues } from '@/lib/form';

interface FormContextValue {
  values: FormValues;
  errors: Record<string, string>;
  set: (path: string, value: unknown) => void;
}

const FormContext = createContext<FormContextValue | null>(null);

export function FormProvider({ value, children }: { value: FormContextValue; children: ReactNode }) {
  return <FormContext.Provider value={value}>{children}</FormContext.Provider>;
}

export function useForm(): FormContextValue {
  const ctx = useContext(FormContext);
  if (!ctx) throw new globalThis.Error('Form controls must be rendered inside <FormProvider>');
  return ctx;
}

const inputClass =
  'mt-1 w-full rounded-md border bg-bg px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-60';

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-red">
      {message}
    </p>
  );
}

interface BaseProps {
  path: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

function Wrapper({ path, label, hint, children, error }: BaseProps & { children: ReactNode; error?: string }) {
  return (
    <div>
      <label htmlFor={path} className="block text-sm">
        {label}
      </label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-muted">{hint}</p>}
      <FieldError id={`${path}-error`} message={error} />
    </div>
  );
}

export function Text(props: BaseProps & { placeholder?: string; type?: string }) {
  const { values, errors, set } = useForm();
  const error = errors[props.path];
  return (
    <Wrapper {...props} error={error}>
      <input
        id={props.path}
        type={props.type ?? 'text'}
        value={String(getIn(values, props.path) ?? '')}
        placeholder={props.placeholder}
        disabled={props.disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${props.path}-error` : undefined}
        onChange={(e) => set(props.path, e.target.value)}
        className={`${inputClass} ${error ? 'border-red' : 'border-border'}`}
      />
    </Wrapper>
  );
}

export function Num(props: BaseProps) {
  return <Text {...props} type="text" />;
}

export function TextArea(props: BaseProps & { rows?: number; placeholder?: string }) {
  const { values, errors, set } = useForm();
  const error = errors[props.path];
  return (
    <Wrapper {...props} error={error}>
      <textarea
        id={props.path}
        rows={props.rows ?? 3}
        placeholder={props.placeholder}
        value={String(getIn(values, props.path) ?? '')}
        disabled={props.disabled}
        aria-invalid={error ? true : undefined}
        onChange={(e) => set(props.path, e.target.value)}
        className={`${inputClass} font-mono ${error ? 'border-red' : 'border-border'}`}
      />
    </Wrapper>
  );
}

export function Select(props: BaseProps & { options: readonly { value: string; label: string }[] }) {
  const { values, errors, set } = useForm();
  const error = errors[props.path];
  return (
    <Wrapper {...props} error={error}>
      <select
        id={props.path}
        value={String(getIn(values, props.path) ?? '')}
        disabled={props.disabled}
        aria-invalid={error ? true : undefined}
        onChange={(e) => set(props.path, e.target.value)}
        className={`${inputClass} ${error ? 'border-red' : 'border-border'}`}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Wrapper>
  );
}

export function Check(props: BaseProps) {
  const { values, errors, set } = useForm();
  const error = errors[props.path];
  return (
    <div>
      <label className="flex items-center gap-2 text-sm">
        <input
          id={props.path}
          type="checkbox"
          checked={Boolean(getIn(values, props.path))}
          disabled={props.disabled}
          onChange={(e) => set(props.path, e.target.checked)}
        />
        {props.label}
      </label>
      {props.hint && !error && <p className="ml-6 mt-1 text-xs text-muted">{props.hint}</p>}
      <FieldError id={`${props.path}-error`} message={error} />
    </div>
  );
}

export function Section({ title, children, description }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`section-${title}`} className="panel p-6">
      <h2 id={`section-${title}`} className="text-base font-semibold">
        {title}
      </h2>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export function Warnings({ items }: { items: { field: string; message: string }[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="sm:col-span-2 space-y-1 text-sm text-amber" aria-label="Warnings">
      {items.map((w) => (
        <li key={w.field}>⚠ {w.message}</li>
      ))}
    </ul>
  );
}
