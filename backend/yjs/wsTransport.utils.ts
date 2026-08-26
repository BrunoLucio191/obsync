import * as decoding from "lib0/decoding";
import { WebSocket, type RawData } from "ws";
import { MAX_WS_MESSAGE_BYTES } from "./yjs.cons.ts";

export function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    const merged = Buffer.concat(data);
    return new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function sendBinaryMessage(
  connection: WebSocket,
  message: Uint8Array,
): void {
  if (connection.readyState !== WebSocket.OPEN) return;

  try {
    connection.send(message, { binary: true });
  } catch (error) {
    console.error("[Yjs] Falha ao enviar mensagem WebSocket:", error);
    connection.terminate();
  }
}

export function closeConnection(
  connection: WebSocket,
  code: number,
  reason: string,
): void {
  if (
    connection.readyState === WebSocket.CLOSING ||
    connection.readyState === WebSocket.CLOSED
  ) {
    return;
  }

  try {
    connection.close(code, reason.slice(0, 123));
  } catch {
    connection.terminate();
  }
}

export function ensureDecoderConsumed(decoder: decoding.Decoder): void {
  if (decoding.hasContent(decoder)) {
    throw new Error("A mensagem Yjs contém bytes inesperados no final.");
  }
}

export function readBoundedByteArray(
  decoder: decoding.Decoder,
  label: string,
): Uint8Array {
  const value = decoding.readVarUint8Array(decoder);

  if (value.byteLength > MAX_WS_MESSAGE_BYTES) {
    throw new Error(`${label} excede o tamanho máximo permitido.`);
  }

  return value;
}
