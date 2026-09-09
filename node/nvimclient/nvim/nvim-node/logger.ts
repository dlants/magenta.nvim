import { resolve } from "node:path";
import winston from "winston";
import {
  type Client,
  type LogLevel,
  MessageType,
  type RPCMessage,
} from "./types.ts";

export function createLogger(client: Client, level: LogLevel, file?: string) {
  const filename = file ? resolve(file) : `/tmp/${client.name}.log`;
  const logger = winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    ),
    transports: [
      new winston.transports.File({
        filename,
        maxsize: 5 * 1024 * 1024, // 5MB per file
        maxFiles: 5,
        tailable: true,
        options: { flags: "a" }, // append so previous-run logs survive restarts
      }),
    ],
  });

  return logger;
}

export function prettyRPCMessage(message: RPCMessage, direction: "out" | "in") {
  const prefix = direction === "out" ? "OUTGOING" : "INCOMING";

  if (message[0] === MessageType.REQUEST) {
    return {
      [`${prefix}_RPC_REQUEST`]: {
        reqId: message[1],
        method: message[2],
        params: message[3],
      },
    };
  }

  if (message[0] === MessageType.RESPONSE) {
    return {
      [`${prefix}_RPC_RESPONSE`]: {
        reqId: message[1],
        error: message[2],
        result: message[3],
      },
    };
  }

  // if (message[0] === MessageType.NOTIFY)
  return {
    [`${prefix}_RPC_NOTIFICATION`]: {
      event: message[1],
      args: message[2],
    },
  };
}
