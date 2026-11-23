import type { ButtonHTMLAttributes } from 'react';

/** Shared button used across the web app. */
export function Button({
  variant = 'primary',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  return <button className={`btn btn-${variant}`} type={type} {...props} />;
}
