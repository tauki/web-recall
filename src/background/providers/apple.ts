import { runInference } from './inference';
import { getSettings } from '../settings/index';
import type { AskPhase } from '../../shared/ask';
import { AppleSafetyBlockError } from '../../shared/providerErrors';

export const APPLE_HOST = 'com.webrecall.apple';
export type AppleMode = 'on-device' | 'private-cloud';
export type AppleStatus = { protocolVersion: number; available: boolean; contextTokens: number; mode: AppleMode; reason?: string; modelName?: string; companionVersion?: string; libraryTools?: boolean };
export type AppleSource = { index: number; title: string; evidence: string; url?: string };
type AppleRequest = {
  action: 'status' | 'generate';
  mode: AppleMode;
  cloudConsent: boolean;
  instructions?: string;
  prompt?: string;
  sources?: AppleSource[];
  toolLimit?: number;
  maxOutputTokens?: number;
  tools?: Array<{ name: string; description: string; parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] } }>;
};
type AppleEvent = { id: string; type: string; text?: string; phase?: AskPhase; status?: AppleStatus; toolCall?: { callId: string; name: string; arguments: string } };
type NativePort = {
  postMessage: (message: Record<string, unknown>) => void;
  disconnect: () => void;
  onMessage: { addListener: (listener: (event: AppleEvent) => void) => void };
  onDisconnect: { addListener: (listener: () => void) => void };
};

export function callApple(
  request: AppleRequest,
  options: { signal?: AbortSignal; onChunk?: (text: string) => void; onProgress?: (text: string) => void; onPhase?: (phase: AskPhase) => void; onToolCall?: (name: string, args: unknown, callId: string) => Promise<{ content: string }> } = {}
): Promise<AppleStatus | string> {
  options.signal?.throwIfAborted();
  if (request.mode === 'private-cloud' && !request.cloudConsent) return Promise.reject(new Error('Private Cloud Compute requires explicit consent.'));
  return runInference(async () => {
    if (request.mode === 'private-cloud' && !(await getSettings()).applePrivateCloud) {
      throw new Error('Private Cloud Compute consent was revoked. Select on-device inference or enable cloud mode again in Settings.');
    }
    options.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      if (typeof chrome.runtime.connectNative !== 'function') {
        reject(new Error('Apple Foundation Models requires Chrome on macOS and the Web Recall native helper.'));
        return;
      }
      const id = crypto.randomUUID();
      const message = { ...request, id };
      if (new TextEncoder().encode(JSON.stringify(message)).length > 4 * 1024 * 1024) {
        reject(new Error('The selected saved pages exceed the native request limit. Choose fewer pages for this answer.'));
        return;
      }
      let port: NativePort;
      let settled = false;
      const toolCalls = new Set<string>();
      const finish = (error?: Error, result?: AppleStatus | string): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', abort);
        port?.disconnect();
        if (error) reject(error); else resolve(result!);
      };
      const abort = (): void => {
        try { port?.postMessage({ id, action: 'cancel' }); }
        catch { finish(new Error('Answer stopped')); return; }
        finish(new Error('Answer stopped'));
      };
      try {
        port = chrome.runtime.connectNative(APPLE_HOST);
        port.onDisconnect.addListener(() => {
          const error = chrome.runtime.lastError?.message;
        if (settled) return;
        const extension = chrome.runtime.id || 'the ID shown in chrome://extensions';
        if (/native messaging host not found/i.test(error || '')) {
          finish(new Error(`Chrome cannot find the Apple bridge. Register the Web Recall companion for extension ${extension}, then retry.`));
        } else if (/native messaging host is forbidden/i.test(error || '')) {
          finish(new Error(`Chrome cannot access the Apple bridge. Check the native-app permission and register this extension ID: ${extension}.`));
        } else finish(new Error(`Apple helper disconnected: ${error || 'check its installation and model availability'}`));
        });
        port.onMessage.addListener((event: AppleEvent) => {
          if (settled || event?.id !== id) return;
          if (event.type === 'tool_call') {
            const call = event.toolCall;
            if (!call || typeof call.callId !== 'string' || toolCalls.has(call.callId) || !request.tools?.some(tool => tool.name === call.name) || !options.onToolCall) { finish(new Error('Apple helper requested an invalid or unavailable saved-memory tool.')); return; }
            toolCalls.add(call.callId);
            void (async () => {
              try {
                options.signal?.throwIfAborted();
                if (request.mode === 'private-cloud' && !(await getSettings()).applePrivateCloud) throw new Error('Private Cloud Compute consent was revoked.');
                const result = await options.onToolCall!(call.name, JSON.parse(call.arguments), call.callId);
                if (!settled && !options.signal?.aborted) port.postMessage({ id, action: 'tool_result', callId: call.callId, result: result.content });
              } catch (error) {
                if (!settled && !options.signal?.aborted) finish(error instanceof Error ? error : new Error(String(error)));
              }
            })();
          } else if (event.type === 'chunk' && typeof event.text === 'string') options.onChunk?.(event.text);
          else if (event.type === 'progress' && typeof event.text === 'string') { options.onProgress?.(event.text); if (event.phase === 'compacting') options.onPhase?.('compacting'); }
          else if (event.type === 'done' && typeof event.text === 'string') finish(undefined, event.text);
          else if (event.type === 'status') {
            const status = event.status;
            if (status && status.protocolVersion !== 2) {
              finish(new Error('Apple helper uses an unsupported protocol. Update and restart the Web Recall Mac companion before asking.'));
            } else if (!status || status.mode !== request.mode || !status.available || !Number.isSafeInteger(status.contextTokens) || status.contextTokens <= 0) {
              finish(new Error('Apple helper reported an unavailable model or invalid context size.'));
            } else finish(undefined, status);
          } else if (event.type === 'error' || event.type === 'cancelled') {
            const text = event.text || 'Apple model request failed.';
            const blocked = event.type === 'error' && (/\bguardrailViolation\b/i.test(text) || /\bmay contain sensitive or unsafe content\b/i.test(text));
            finish(blocked ? new AppleSafetyBlockError() : new Error(text));
          }
        });
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) { abort(); return; }
        port.postMessage(message);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}

export async function getAppleStatus(mode: AppleMode = 'on-device', cloudConsent = false, signal?: AbortSignal): Promise<AppleStatus> {
  return await callApple({ action: 'status', mode, cloudConsent }, { signal }) as AppleStatus;
}
