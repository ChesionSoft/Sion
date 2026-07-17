import { useId, type InputHTMLAttributes, type SelectHTMLAttributes } from "react";

type FieldChromeProps = {
  label: string;
  hint?: string;
  error?: string;
};

export type FieldProps = FieldChromeProps & InputHTMLAttributes<HTMLInputElement>;

export function Field({ label, hint, error, id, className = "", ...props }: FieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = hint || error ? `${controlId}-description` : undefined;
  return (
    <label className="ui-field" htmlFor={controlId}>
      <span className="ui-field-label">{label}</span>
      <input
        id={controlId}
        className={`ui-input ${className}`.trim()}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={descriptionId}
        {...props}
      />
      {error ? <span className="ui-field-error" id={descriptionId}>{error}</span> : hint ? <span className="ui-field-hint" id={descriptionId}>{hint}</span> : null}
    </label>
  );
}

export type SelectFieldProps = FieldChromeProps & SelectHTMLAttributes<HTMLSelectElement>;

export function SelectField({ label, hint, error, id, className = "", children, ...props }: SelectFieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = hint || error ? `${controlId}-description` : undefined;
  return (
    <label className="ui-field" htmlFor={controlId}>
      <span className="ui-field-label">{label}</span>
      <select
        id={controlId}
        className={`ui-select ${className}`.trim()}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={descriptionId}
        {...props}
      >
        {children}
      </select>
      {error ? <span className="ui-field-error" id={descriptionId}>{error}</span> : hint ? <span className="ui-field-hint" id={descriptionId}>{hint}</span> : null}
    </label>
  );
}
