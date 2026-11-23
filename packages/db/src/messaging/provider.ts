/** Everything the platform needs from a messaging channel. A real WhatsApp client implements this later. */
export interface OutboundText {
  phoneNumberId: string;
  /** Recipient wa_id (digits, no +). */
  to: string;
  body: string;
  /** Our message id: lets a provider that supports it deduplicate re-sends after a crash. */
  idempotencyKey: string;
}

/** The provider rejected the message for good (invalid recipient, blocked...). Do not retry. */
export class PermanentSendError extends Error {}

export interface WhatsAppSender {
  /** Returns the provider message id. Throw PermanentSendError for non-retryable failures; any other error is retried. */
  sendText(msg: OutboundText): Promise<{ providerMessageId: string }>;
}

/** In-memory provider for tests and local development. It never touches the network. */
export class MockWhatsAppSender implements WhatsAppSender {
  readonly sent: OutboundText[] = [];
  /** Queue of failures to raise on upcoming calls, consumed in order. */
  failures: Error[] = [];
  private seq = 0;

  async sendText(msg: OutboundText): Promise<{ providerMessageId: string }> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push(msg);
    this.seq += 1;
    return { providerMessageId: `wamid.mock.${Date.now()}.${this.seq}` };
  }
}
