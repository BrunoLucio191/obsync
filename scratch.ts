import { Buffer } from "node:buffer";

const bar = "esse ☠️ string aqui tem tanto tamanho";
const len = bar.length;
const foo = Buffer.byteLength(bar);

console.log(len, foo);
