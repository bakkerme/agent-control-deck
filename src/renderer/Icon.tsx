export default function Icon({ name }: { name: "pencil" | "check" | "x" | "flag" | "sparkles" }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "sparkles" ? <><path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3Z" /><path d="M20 2v4m-2-2h4M3 18v4m-2-2h4" /></> : name === "pencil" ? <><path d="m15 5 4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4 15z" /></> : name === "flag" ? <><path d="M5 21V3m0 1c5-4 9 4 14 0v10c-5 4-9-4-14 0" /></> : name === "check" ? <path d="m5 12 4 4 10-10" /> : <path d="m6 6 12 12M6 18 18 6" />}
  </svg>;
}
