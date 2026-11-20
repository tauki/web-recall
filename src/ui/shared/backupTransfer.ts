type Reply = { pages: number; staged?: number; complete?: boolean; line?: string; stopped?: boolean; error?: string };

export class BackupTransfer {
  private port = chrome.runtime.connect({ name: 'web-recall-backup' });
  private sequence = 0;
  private waiting = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
  private closed = false;
  private cancellation?: Promise<Reply>;
  pages = 0;

  constructor(private mode: 'export' | 'import', private recover = false, private options?: { format: 'json' | 'markdown'; urls?: string[] }) {
    this.port.onMessage.addListener(this.receive);
    this.port.onDisconnect.addListener(this.disconnected);
  }

  private receive = (value: unknown): void => {
    const reply = value as Reply & { id?: number };
    const pending = reply && this.waiting.get(reply.id!);
    if (!pending) { this.fail(new Error('Invalid backup acknowledgement. The transfer did not complete.')); this.close(); return; }
    this.waiting.delete(reply.id!);
    if (!Number.isSafeInteger(reply.pages) || reply.pages < this.pages ||
        (reply.staged !== undefined && (!Number.isSafeInteger(reply.staged) || reply.staged < 0)) ||
        (reply.error !== undefined && typeof reply.error !== 'string')) {
      pending.reject(new Error('Invalid backup response. The transfer did not complete.'));
      this.close();
      return;
    }
    this.pages = reply.pages;
    if (reply.error) pending.reject(new Error(reply.error));
    else pending.resolve(reply);
  };

  private disconnected = (): void => {
    void chrome.runtime.lastError;
    const uncertain = this.mode === 'import' && this.waiting.size ? this.recover ? ' The library restore may have completed.' : ' The last page may have completed.' : '';
    this.fail(new Error(`Backup connection lost; ${this.pages} pages confirmed.${uncertain}`));
  };

  private fail(error: Error): void {
    this.closed = true;
    for (const pending of this.waiting.values()) pending.reject(error);
    this.waiting.clear();
  }

  private request(action: string, fields: Record<string, unknown> = {}): Promise<Reply> {
    if (this.closed) return Promise.reject(new Error(`Backup connection closed; ${this.pages} pages confirmed.`));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      try { this.port.postMessage({ id, action, ...fields }); }
      catch { this.disconnected(); }
    });
  }

  async next(line?: string): Promise<Reply> {
    const reply = await this.request(this.mode, line === undefined ? (this.sequence === 0 ? this.options : undefined) : { line, ...(this.recover ? { recover: true } : {}) });
    if (typeof reply.complete !== 'boolean' || (this.mode === 'export' && typeof reply.line !== 'string')) throw new Error('Incomplete backup response. The transfer did not complete.');
    return reply;
  }

  importLegacy(pages: unknown[], schemaVersion?: number): Promise<Reply> {
    return this.request('legacy', { pages, schemaVersion, ...(this.recover ? { recover: true } : {}) });
  }

  publishRestore(): Promise<Reply> { return this.request('publish'); }

  cancel(): Promise<Reply> {
    return this.cancellation ||= this.request('cancel').then(reply => {
      if (reply.stopped !== true && !(this.recover && reply.complete === true)) throw new Error('Stopping the import was not confirmed. The last page may have completed.');
      return reply;
    });
  }

  close(): void {
    this.port.onMessage.removeListener(this.receive);
    this.port.onDisconnect.removeListener(this.disconnected);
    this.port.disconnect();
    this.fail(new Error(`Backup connection closed; ${this.pages} pages confirmed.`));
  }
}
