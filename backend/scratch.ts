interface customMap<K, V> extends Map<K, V> {
  increment(key: K): void;
  decrement(key: K): void;
  bigger(): any;
}

// custom Map implementation for increment, decrement and bigger
export const getMessageCounter = () => {
  const connectionMessageCounter = new Map<any, number>();
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
    if (connectionMessageCounter.size === 0) {
      return null;
    }
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
  return connectionMessageCounter as customMap<any, number>;
};

const test = getMessageCounter();
test.set("myBoy", 1);
console.log(test.size);
console.log(test.bigger());
