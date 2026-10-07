import type { Chat, ChatLink, LinkRule } from "../shared/types";
import { linkCategory, linkLabel } from "../shared/links";
import { displayName } from "./components";

export default function LinkStack({ links, rules, chats, scope, open, selectChat }: {
  links: ChatLink[]; rules: LinkRule[]; chats: Chat[]; scope: "Project" | "Chat";
  open: (id: string) => void; selectChat?: (chat: Chat) => void;
}) {
  const byChat = new Map(chats.map(chat => [chat.id, chat]));
  const unique = new Map<string, { link: ChatLink; sources: Chat[] }>();
  for (const link of links) {
    const chat = byChat.get(link.chatId);
    if (!chat) continue;
    const existing = unique.get(link.url);
    if (existing) {
      if (!existing.sources.some(source => source.id === chat.id)) existing.sources.push(chat);
      if (!existing.link.label && link.label) existing.link = link;
    } else unique.set(link.url, { link, sources: [chat] });
  }
  const categories = new Map<string, { link: ChatLink; sources: Chat[] }[]>();
  for (const entry of unique.values()) {
    const category = linkCategory(entry.link.url, rules);
    const group = categories.get(category) ?? [];
    group.push(entry);
    categories.set(category, group);
  }
  if (!unique.size) return null;
  return <section className={`link-stack ${scope.toLowerCase()}-links`} aria-label={`${scope} links`}>
    {[...categories].sort(([a], [b]) => a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)).map(([category, entries]) =>
      <div className="link-group" key={category}>
        {entries.map(({ link, sources }, index) => <div className={`detected-link ${selectChat ? "has-source" : ""}`} key={link.url}>
          <span className="link-category" title={category}>{index === 0 ? category : ""}</span>
          <button className="link-destination" title={link.url} aria-label={`Open link ${linkLabel(link)}`} onClick={() => open(link.id)}><span className="link-label">{linkLabel(link)}</span><span className="external-mark" aria-hidden="true">↗</span></button>
          {selectChat && (sources.length === 1 ? <button className="link-source" title={`From ${displayName(sources[0])}${sources[0].archived ? " · Archived" : ""}`} aria-label={`Select source chat ${displayName(sources[0])}`} onClick={() => selectChat(sources[0])}>{displayName(sources[0])}</button>
            : <details className="link-sources"><summary>{sources.length} chats</summary><div>{sources.map(source => <button key={source.id} title={displayName(source)} onClick={() => selectChat(source)}>{displayName(source)}{source.archived && " · Archived"}</button>)}</div></details>)}
        </div>)}
      </div>)}
  </section>;
}
