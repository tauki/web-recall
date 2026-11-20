import { abortable } from '../../shared/abort';
import { pageContent } from '../../shared/pageContent';
import type { PageRecord } from '../storage/manager';
import type { SavedVersionSource } from '../../shared/pageHistory';

const active = new Set<{ source: SavedVersionSource; controller: AbortController }>();
const replacements = new Map<string, Promise<void>>();
const epochs = new Map<string, number>();
const scopes = new Set<{ epoch: number; urls?: Set<string> }>();
let sequence = 0;
let libraryGeneration = 0;

export function invalidateSavedLibraryWork(): void {
  libraryGeneration++;
  for (const entry of active) entry.controller.abort(new Error('The saved library was restored. Retry from the current library.'));
}

export type SavedWorkScope = { check: (url: string) => void; release: () => void };

export function beginSavedWork(urls?: string[]): SavedWorkScope {
  const generation = libraryGeneration;
  const scope = { epoch: sequence, urls: urls ? new Set(urls) : undefined };
  scopes.add(scope);
  return {
    check(url) {
      if (generation !== libraryGeneration) throw new Error('The saved library was restored. Retry from the current library.');
      if ((epochs.get(url) || 0) > scope.epoch) throw new Error('The saved page was replaced by a restore. Retry from the current library.');
    },
    release() {
      scopes.delete(scope);
      for (const [url, epoch] of epochs) if (![...scopes].some(candidate => candidate.epoch < epoch && (!candidate.urls || candidate.urls.has(url)))) epochs.delete(url);
    }
  };
}

export async function replaceSavedWork<T>(url: string, replace: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const preceding = replacements.get(url);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  replacements.set(url, barrier);
  try {
    await abortable(preceding || Promise.resolve(), signal);
    signal?.throwIfAborted();
    const result = await replace();
    const epoch = ++sequence;
    if ([...scopes].some(scope => !scope.urls || scope.urls.has(url))) epochs.set(url, epoch);
    for (const entry of active) if (entry.source.url === url) entry.controller.abort(new Error('The saved page was replaced by a restore. Retry from the current library.'));
    return result;
  } finally {
    const cleanup = (): void => { release(); if (replacements.get(url) === barrier) replacements.delete(url); };
    if (preceding && signal?.aborted) void preceding.then(cleanup);
    else cleanup();
  }
}

export async function runSavedWork<T>(page: PageRecord, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>, scope?: SavedWorkScope): Promise<T> {
  const token = scope || beginSavedWork([page.url]);
  try {
    await abortable(replacements.get(page.url) || Promise.resolve(), signal);
    signal?.throwIfAborted();
    token.check(page.url);
    const controller = new AbortController();
    const entry = { source: { url: page.url, versionId: page.versionId, timestamp: page.timestamp, title: page.title, text: pageContent(page) }, controller };
    const cancel = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    active.add(entry);
    try { return await abortable(run(controller.signal), controller.signal); }
    finally { active.delete(entry); signal?.removeEventListener('abort', cancel); }
  } finally { if (!scope) token.release(); }
}

export function cancelSavedWork(removed: SavedVersionSource[]): void {
  for (const entry of active) {
    const source = entry.source;
    if (removed.some(version => version.url === source.url && (source.versionId ? version.versionId === source.versionId : version.title === source.title && version.text === source.text && source.timestamp >= (version.firstCapturedAt ?? version.timestamp) && source.timestamp <= version.timestamp))) {
      entry.controller.abort(new Error('This saved version was forgotten.'));
    }
  }
}
