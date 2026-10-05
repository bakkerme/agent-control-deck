export default function Icon({ name }: { name: "pencil" | "check" | "x" }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "pencil" ? <><path d="m15 5 4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15z" /></> : name === "check" ? <path d="m5 12 4 4 10-10" /> : <path d="m6 6 12 12M6 18 18 6" />}
  </svg>;
}
