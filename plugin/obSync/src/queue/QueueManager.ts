import Queue from '../queue/Queue.ts';
import type { KeyedLock } from './KeyedLock.ts';

/**
 * Menages all queues that are created per user. Every queue it builds shares the
 * same Keyed Lock, so two users running the same keyed operation still
 * wait for each other even though their queues are independent.
 *
 * A queue is removed as soon as it drains and the next request creates a new one,
 * so callers must add their task right after getOrCreateQueue instead of keeping
 * the queue around across an await.
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
