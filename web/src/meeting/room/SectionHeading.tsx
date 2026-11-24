import type { ReactNode } from 'react';

/** The three jobs Kaki does in a meeting, each with its own icon and accent. */
export type SectionIconName = 'clock' | 'sparkle' | 'action';

/** One inline icon shared by the panel headings and the stage pill. */
export function SectionIcon({ name, className }: { name: SectionIconName; className?: string }) {
  const shared = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...(className === undefined ? {} : { className }),
  };
  if (name === 'clock') {
    return (
      <svg {...shared}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  }
  if (name === 'sparkle') {
    // Wingman: a sparkle, the familiar sign for a tip from an assistant.
    return (
      <svg {...shared}>
        <path d="M10 3.5l1.9 5.1 5.1 1.9-5.1 1.9L10 17.5l-1.9-5.1L3 10.5l5.1-1.9Z" />
        <path d="M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z" />
      </svg>
    );
  }
  return (
    <svg {...shared}>
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="m8 12 3 3 5-6" />
    </svg>
  );
}

/** A small mono eyebrow that opens one section of the Kaki panel. */
export function SectionHeading({
  icon,
  tone,
  children,
  aside,
}: {
  icon: SectionIconName;
  tone: 'host' | 'wingman' | 'action';
  children: ReactNode;
  /** Small text on the right, such as "private to you" or a task count. */
  aside?: ReactNode;
}) {
  return (
    <div className="kd-section-head" data-tone={tone}>
      <p className="eyebrow kd-section-title">
        <SectionIcon name={icon} />
        <span>{children}</span>
      </p>
      {aside === undefined ? null : <span className="kd-section-aside">{aside}</span>}
    </div>
  );
}
