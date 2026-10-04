// Codex can prepend attachment context to a submitted prompt. This is a
// display heuristic, not the provider's sidebar title or a transcript parser.
export function codexPrompt(value: string): { content: string; attachment: string } {
  const query = value.match(/<user_query>([\s\S]*?)<\/user_query>/i);
  if (query) return { content: query[1].trim(), attachment: "" };
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  const header = /^# Files mentioned by the user:\s*/i;
  if (!header.test(normalized)) return { content: normalized, attachment: "" };
  const rest = normalized.replace(header, "");
  const file = /^##\s+([^\n:]+):[ \t]*(?:\/|[a-z]:[\\/]|\\\\)/i;
  const attachment = rest.match(file)?.[1].trim() ?? "";
  if (!attachment) return { content: normalized, attachment: "" };
  // Legacy previews/titles were flattened before truncation. Their remaining
  // path cannot reliably be separated from a request; use the attachment label.
  const lines = rest.split("\n");
  while (lines.length && (!lines[0].trim() || file.test(lines[0]))) lines.shift();
  return { content: lines.join("\n").trim(), attachment };
}

export function promptTitle(value: string, codex = false): string {
  const { content, attachment } = codex
    ? codexPrompt(value)
    : { content: value, attachment: "" };
  return (content || attachment)
    .replace(/<\/?user_query>/gi, "")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/\[([^\]]+)\]\([^\n)]*\)/g, "$1")
    .replace(/(\*\*|__|`)([^\n]*?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}
