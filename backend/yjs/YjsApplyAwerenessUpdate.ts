import { WebSocket } from "ws";
import { YjsRoom } from "./yjsRooms/YjsRoom.ts";
import * as awarenessProtocol from "y-protocols/awareness";

/** receives an awareness update and applies it */
export const applyAwerenessUpdate = (
  room: YjsRoom,
  connection: WebSocket,
  update: Uint8Array,
) => {
  awarenessProtocol.applyAwarenessUpdate(room.awareness, update, connection);
};
