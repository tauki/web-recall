import { beginWorkerLease } from '../lifetime';

export async function runInference<T>(operation: () => Promise<T>): Promise<T> {
  const release = beginWorkerLease();
  try {
    return await operation();
  } finally {
    release();
  }
}
