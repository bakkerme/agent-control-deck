import type { ReactNode } from "react";

export default function TitleBar({
  subtitle,
  children,
}: {
  subtitle: string;
  children?: ReactNode;
}) {
  return (
    <header className="titlebar">
      <div className="titlebar-content">
        <div className="titlebar-brand">
          <h1>Agent Control Deck</h1>
          <span className="muted">{subtitle}</span>
        </div>
        {children}
      </div>
    </header>
  );
}
