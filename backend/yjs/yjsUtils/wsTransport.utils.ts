import * as decoding from "lib0/decoding";
import { WebSocket, type RawData } from "ws";
import { MAX_WS_MESSAGE_BYTES } from "./yjs.cons.ts";

/**
 * Coerces a raw `ws` message payload (which may be a Buffer, an array of Buffers, or an ArrayBuffer)
 * into a plain `Uint8Array` view, without copying when avoidable.
 * @param data - Raw message data as delivered by the `ws` library.
 * @returns A `Uint8Array` view over the message bytes.
 */
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

/**
 * Sends a binary Yjs protocol message to a connection, silently no-op'ing if it isn't open
 * and terminating it if the send itself throws.
 * @param connection - Target WebSocket connection.
 * @param message - Encoded message bytes to send.
 */
export function sendBinaryMessage(
  connection: WebSocket,
  message: Uint8Array,
): void {
  if (connection.readyState !== WebSocket.OPEN) return;

  try {
    connection.send(message, { binary: true });
  } catch (error) {
    console.error("[Yjs] Failed to send WebSocket message:", error);
    connection.terminate();
  }
}

/**
 * Gracefully closes a WebSocket connection with a close code/reason, falling back to a hard
 * `terminate()` if the graceful close throws. No-ops if the connection is already closing/closed.
 * @param connection - Connection to close.
 * @param code - WebSocket close code (e.g. 1008 for policy violation).
 * @param reason - Human-readable close reason; truncated to the 123-byte protocol limit.
 */
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

/**
 * Asserts that a decoder has been fully consumed, guarding against malformed/oversized
 * messages that carry unexpected trailing bytes.
 * @param decoder - Decoder that should have no remaining content.
 * @throws If the decoder still has unread bytes.
 */
export function ensureDecoderConsumed(decoder: decoding.Decoder): void {
  if (decoding.hasContent(decoder)) {
    throw new Error("The Yjs message contains unexpected trailing bytes.");
  }
}

/**
 * Reads a length-prefixed byte array from a decoder, rejecting it if it exceeds the
 * maximum allowed WebSocket message size (guards against memory-exhaustion payloads).
 * @param decoder - Decoder positioned at a var-uint8-array field.
 * @param label - Human-readable name of the field, used in the thrown error message.
 * @returns The decoded byte array.
 * @throws If the decoded array is larger than {@link MAX_WS_MESSAGE_BYTES}.
 */
export function readBoundedByteArray(
  decoder: decoding.Decoder,
  label: string,
): Uint8Array {
  const value = decoding.readVarUint8Array(decoder);

  if (value.byteLength > MAX_WS_MESSAGE_BYTES) {
    throw new Error(`${label} exceeds the maximum allowed size.`);
  }

  return value;
}
