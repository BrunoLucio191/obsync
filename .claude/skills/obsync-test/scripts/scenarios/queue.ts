// Queue / QueueManager / KeyedLock, backend and plugin copies: order, draining and cleanup.
import path from "node:path";
import { BACKEND, PLUGIN, captureLogs } from "../lib/env.ts";
import { createChecks } from "../lib/check.ts";

const logs = captureLogs();
const checks = createChecks("queue", logs.out);
const flush = () => new Promise((r) => setImmediate(r));

for (const [label, dir] of [
  ["backend", path.join(BACKEND, "queue")],
  ["plugin", path.join(PLUGIN, "src/queue")],
] as const) {
  const { QueueManager } = await import(path.join(dir, "QueueManager.ts"));
  const { KeyedLock } = await import(path.join(dir, "KeyedLock.ts"));

  await checks.check(`${label}: tarefas rodam em ordem de chegada`, async () => {
    const queue = new QueueManager(new KeyedLock()).getOrCreateQueue("a");
    const order: number[] = [];
    await Promise.all(
      [30, 0, 10].map((ms, i) =>
        queue.addTask(async () => {
          await new Promise((r) => setTimeout(r, ms));
          order.push(i);
        }, `k${i}`),
      ),
    );
    if (order.join() !== "0,1,2") throw new Error(`ordem ${order}`);
  });
  await checks.check(`${label}: fila some quando esvazia e nao some ocupada`, async () => {
    const manager = new QueueManager(new KeyedLock());
    const queue = manager.getOrCreateQueue("a");
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    const busy = queue.addTask(() => gate, "k");
    await flush();
    if (manager.getOrCreateQueue("a") !== queue) throw new Error("removida enquanto processava");
    open();
    await busy;
    await flush();
    if (manager.getOrCreateQueue("a") === queue) throw new Error("nao foi removida depois de esvaziar");
  });
  await checks.check(`${label}: fila antiga esvaziando nao remove a nova`, async () => {
    const manager = new QueueManager(new KeyedLock());
    const old = manager.getOrCreateQueue("a");
    await old.addTask(async () => {}, "k");
    await flush();
    const newer = manager.getOrCreateQueue("a");
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    const busy = newer.addTask(() => gate, "k2");
    await old.addTask(async () => {}, "k3");
    await flush();
    if (manager.getOrCreateQueue("a") !== newer) throw new Error("a fila nova foi removida");
    open();
    await busy;
  });
  await checks.check(`${label}: tarefa com erro rejeita a promise e a fila continua`, async () => {
    const queue = new QueueManager(new KeyedLock()).getOrCreateQueue("a");
    const failed = queue.addTask(async () => {
      throw new Error("boom");
    }, "k");
    const next = queue.addTask(async () => "depois", "k2");
    const [first, second] = await Promise.allSettled([failed, next]);
    if (first.status !== "rejected" || second.status !== "fulfilled") throw new Error("erro nao isolado");
  });
  await checks.check(`${label}: mesma chave em filas diferentes nunca roda junto`, async () => {
    const manager = new QueueManager(new KeyedLock());
    let running = 0;
    let overlap = false;
    const task = async () => {
      running++;
      if (running > 1) overlap = true;
      await new Promise((r) => setTimeout(r, 5));
      running--;
    };
    await Promise.all(["a", "b", "c"].map((id) => manager.getOrCreateQueue(id).addTask(task, "same")));
    if (overlap) throw new Error("duas tarefas com a mesma chave rodaram ao mesmo tempo");
  });
}

process.exit(checks.finish());
