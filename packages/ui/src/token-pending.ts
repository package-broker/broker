import { loadPending, type PendingStorage } from './pending.js';

export function pendingStorage(storage: PendingStorage): PendingStorage {
  return {
    getItem: (key) => storage.getItem(`tokens:${key}`),
    setItem: (key, value) => storage.setItem(`tokens:${key}`, value),
    removeItem: (key) => storage.removeItem(`tokens:${key}`),
  };
}
export function clearPendingTokenIssue(storage: PendingStorage): void {
  loadPending(pendingStorage(storage), Date.now());
}
