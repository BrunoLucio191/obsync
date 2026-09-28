import Queue from '../queue/Queue.ts';
import type { KeyedLock } from './KeyedLock.ts';

/**
 * One queue per user, all sharing the same KeyedLock. A queue is removed once it drains, so
 * add the task right after getOrCreateQueue instead of holding the queue across an await.
 */
export class QueueManager {
	#dbQueuesRecord = new Map<string, Queue>();
	#lock: KeyedLock;

	constructor(lock: KeyedLock) {
		this.#lock = lock;
	}

	public getOrCreateQueue(userId: string): Queue {
		if (!userId) {
			throw new Error('[QueueManager] There is no user identifier');
		}

		let queue = this.#dbQueuesRecord.get(userId);
		if (!queue) {
			const created = new Queue(this.#lock, () => {
				// An old queue draining late must not remove a newer one of the same user
				if (this.#dbQueuesRecord.get(userId) === created) {
					this.#dbQueuesRecord.delete(userId);
				}
			});
			this.#dbQueuesRecord.set(userId, created);
			queue = created;
		}
		return queue;
	}
}
