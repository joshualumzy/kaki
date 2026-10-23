import type { ReactNode } from 'react';

/** Shared surface for grouped content on the screen and phone. */
export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="card">
      {title === undefined ? null : <h2 className="card-title">{title}</h2>}
      {children}
    </section>
  );
}
