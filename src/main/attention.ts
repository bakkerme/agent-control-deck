import type { Chat } from "../shared/types";

export function inputNeededCount(chats: Chat[]): number {
  return chats.filter(c => !c.archived && c.lifecycle === "open" && c.state === "waiting").length;
}

export class InputIndicator {
  private lastCount: number | undefined;
  constructor(private readonly apply: (count: number) => void) {}
  update(chats: Chat[], force = false): void {
    const count = inputNeededCount(chats);
    if (!force && count === this.lastCount) return;
    this.apply(count);
    this.lastCount = count;
  }
}
