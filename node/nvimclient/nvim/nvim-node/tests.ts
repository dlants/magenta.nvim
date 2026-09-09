import { attach } from "./index.ts";

const SOCKET = process.env.NVIM;
if (!SOCKET) throw Error("socket missing");

type MyEvents = {
  notifications: {
    "some-notification": [name: string, id: number];
  };
  requests: {
    "some-request": [name: string];
  };
};

const nvim = await attach<MyEvents>({
  socket: SOCKET,
  client: {
    name: "node",
    version: {
      minor: 0,
    },
    methods: {
      "some-method": {
        async: false,
        nargs: 9,
      },
    },
    attributes: {
      website: "https://wallpants.io",
    },
  },
  logging: { level: "debug" },
});

nvim.detach();
