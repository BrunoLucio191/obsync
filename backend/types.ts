import { WebSocket } from "ws";

export type UserMetadata = {
  ws: WebSocket;
  connectedAt: Date;
  ip: string | undefined;
};

export type File = {
  content: string;
  name: string;
  oldName: string;
  path?: string;
};

export type syncVault = {
  myFlag: boolean;
  name: string;
};
