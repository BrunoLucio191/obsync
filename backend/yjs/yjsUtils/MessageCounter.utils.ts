import type WebSocket from "ws";

export interface WebSocketMessageCounter<K, V> extends Map<K, V> {
  increment(key: K): void;
  decrement(key: K): void;
  biggest(): WebSocket | null;
}
// custom Map implementation for increment, decrement and biggest
export const getMessageCounter = () => {
  const connectionMessageCounter = new Map<WebSocket, number>();
  connectionMessageCounter.constructor.prototype.increment = function (
    key: any,
  ) {
    if (this.has(key)) {
      this.set(key, this.get(key) + 1);
    } else {
      this.set(key, 0);
    }
  };
  connectionMessageCounter.constructor.prototype.decrement = function (
    key: any,
  ) {
    if (this.has(key)) {
      if (this.get(key) > 0) {
        this.set(key, this.get(key) - 1);
      }
    } else {
      return;
    }
  };
  connectionMessageCounter.constructor.prototype.biggest = function () {
    if (this.size === 0) return null;
    let biggestValue = 0;
    let biggestKey = null;

    for (const [key, value] of this) {
      if (value > biggestValue) {
        biggestValue = value;
        biggestKey = key;
      }
    }
    return biggestKey;
  };
  return connectionMessageCounter as WebSocketMessageCounter<WebSocket, number>;
};
