import { storageManager } from '../storage/manager';

export function listLogs(limit = 200) {
  return storageManager.listLogs(limit);
}

export function clearLogs() {
  return storageManager.clearLogs();
}
