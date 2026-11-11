export type LocalTestMailKind = "verify_email" | "password_reset";

export interface LocalTestMailMessage {
  id: string;
  email: string;
  kind: LocalTestMailKind;
  link: string;
  sentAt: number;
}

const maxMessagesPerMailbox = 10;
const maxStoredMessages = 500;

function lifetimeFor(kind: LocalTestMailKind): number {
  return kind === "verify_email"
    ? 24 * 60 * 60 * 1000
    : 30 * 60 * 1000;
}

export class LocalTestMailAdapter {
  private readonly mailboxes = new Map<string, LocalTestMailMessage[]>();

  send(
    email: string,
    kind: LocalTestMailKind,
    link: string,
    sentAt: number,
  ): void {
    this.prune(sentAt);
    const messages = this.mailboxes.get(email) ?? [];
    messages.push({
      id: crypto.randomUUID(),
      email,
      kind,
      link,
      sentAt,
    });
    if (messages.length > maxMessagesPerMailbox) messages.shift();
    this.mailboxes.set(email, messages);
    this.pruneToBound();
  }

  list(email: string, now: number): LocalTestMailMessage[] {
    this.prune(now);
    return [...(this.mailboxes.get(email) ?? [])];
  }

  discardToken(token: string): void {
    for (const [email, messages] of this.mailboxes) {
      const remaining = messages.filter(
        (message) => !message.link.endsWith(`#token=${encodeURIComponent(token)}`),
      );
      if (remaining.length === 0) this.mailboxes.delete(email);
      else if (remaining.length !== messages.length) {
        this.mailboxes.set(email, remaining);
      }
    }
  }

  private prune(now: number): void {
    for (const [email, messages] of this.mailboxes) {
      const remaining = messages.filter(
        (message) => now - message.sentAt < lifetimeFor(message.kind),
      );
      if (remaining.length === 0) this.mailboxes.delete(email);
      else if (remaining.length !== messages.length) {
        this.mailboxes.set(email, remaining);
      }
    }
  }

  private pruneToBound(): void {
    let total = 0;
    for (const messages of this.mailboxes.values()) total += messages.length;
    while (total > maxStoredMessages) {
      const [email, messages] = this.mailboxes.entries().next().value ?? [];
      if (!email || !messages) return;
      messages.shift();
      total -= 1;
      if (messages.length === 0) this.mailboxes.delete(email);
    }
  }
}
