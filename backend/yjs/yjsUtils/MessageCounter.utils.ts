import type WebSocket from "ws";
interface WebSocketMessageCount<K, V> extends Map<K, V> {
  increment(key: K): void;
  decrement(key: K): void;
  bigger(): WebSocket;
}
// custom Map implementation for increment, decrement and bigger
export const getMessageCounter = () => {
  const connectionMessageCounter = new Map<WebSocket, number>();
  connectionMessageCounter.constructor.prototype.increment = function (
    key: any,
  ) {
    this.has(key) && this.set(key, this.get(key) + 1);
  };
  connectionMessageCounter.constructor.prototype.decrement = function (
    key: any,
  ) {
    this.has(key) && this.set(key, this.get(key) + 1);
  };
  connectionMessageCounter.constructor.prototype.bigger = function () {
    if (connectionMessageCounter.size === 0) return null;
    let biggestValue = 0;
    let biggestKey = null;
    for (const [key, value] of connectionMessageCounter) {
      if (value > biggestValue) {
        biggestValue = value;
        biggestKey = key;
      }
      return biggestKey;
    }
  };
  return connectionMessageCounter as WebSocketMessageCount<WebSocket, number>;
};
