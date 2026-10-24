import type { ReactNode } from "react";

export function PageSection({
  title, actions, children,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      {(title || actions) ? (
        <div className="mb-3 flex items-center justify-between">
          {title ? <h2 className="text-base font-semibold">{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}
