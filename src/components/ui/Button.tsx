import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
  loadingLabel?: string;
};

export function Button({
  variant = "secondary",
  loading = false,
  loadingLabel = "处理中…",
  disabled,
  children,
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      className={`ui-button ui-button-${variant} ${className}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? loadingLabel : children}
    </button>
  );
}

export function IconButton({
  "aria-label": ariaLabel,
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  if (!ariaLabel) throw new Error("IconButton requires aria-label");
  return (
    <button
      className={`ui-icon-button ${className}`.trim()}
      aria-label={ariaLabel}
      title={props.title ?? ariaLabel}
      type={type}
      {...props}
    />
  );
}
