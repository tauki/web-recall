import { ChatDisabledError } from '../../shared/providerErrors';

let enabledWork = new AbortController();

export function chatWorkSignal(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, enabledWork.signal]) : enabledWork.signal;
}

export function stopChatWork(): void {
  const previous = enabledWork;
  enabledWork = new AbortController();
  previous.abort(new ChatDisabledError());
}
