import type { ReactNode } from 'react';

/** Shared surface for grouped content on the screen and phone. */
export function Card({ title, children, id }: { title?: string; children: ReactNode; id?: string }) {
  return (
    <section className="card" id={id}>
      {title === undefined ? null : <h2 className="card-title">{title}</h2>}
      {children}
    </section>
  );
}
