import { Bridge, attachWs } from "./bridge.js";
import { startHid } from "./hid.js";
import { resolvePorts } from "./detect.js";
import { WebSocketServer } from "ws";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  return fallback;
}

function argNum(name: string, fallback: number): number {
  const raw = arg(name, String(fallback));
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

const cli = {
  txPort: arg("--tx-port", process.env.TX_PORT ?? "auto"),
  fcPort: arg("--fc-port", process.env.FC_PORT ?? "auto"),
  txReq: arg("--tx-port", process.env.TX_PORT ?? "auto"),
  fcReq: arg("--fc-port", process.env.FC_PORT ?? "auto"),
  txBaud: argNum("--tx-baud", Number(process.env.TX_BAUD ?? 921600)),
  fcBaud: argNum("--fc-baud", Number(process.env.FC_BAUD ?? 115200)),
  wsPort: argNum("--ws-port", Number(process.env.WS_PORT ?? 8080)),
};

if (hasFlag("--list-ports")) {
  const { SerialPort } = await import("serialport");
  for (const p of await SerialPort.list()) {
    console.log(`${p.path}  fab=${p.manufacturer ?? "?"} vid=${p.vendorId ?? "?"} pid=${p.productId ?? "?"}`);
  }
  process.exit(0);
}

const { txPort, fcPort } = await resolvePorts(cli.txPort, cli.fcPort);
const opts = { ...cli, txPort, fcPort };

const bridge = new Bridge(opts);
const wss = new WebSocketServer({ port: opts.wsPort });
// EADDRINUSE netjes melden i.p.v. een Node-stackdump: de frontend toont
// zelf een verbindingsbanner met retry, dus hier volstaat een schone exit.
wss.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `WS-poort ${opts.wsPort} is al in gebruik — draait er nog een bridge? Stop die eerst of start met --ws-port <vrij>.`,
    );
  } else {
    console.error(`WebSocket-server fout: ${err.message}`);
  }
  process.exit(1);
});
attachWs(wss, bridge);

// Controller voor headless gebruik. Xbox-pads zijn over USB meestal XInput
// (geen HID): gebruik dan de frontend (Gamepad-API). --hid=auto pakt een
// HID-joystick (Boxer e.d.); --hid=/dev/hidraw0 forceert een pad.
const hidEq = process.argv.find((a) => a.startsWith("--hid="));
const hidPath = hidEq ? hidEq.slice("--hid=".length) : (process.env.HID_PATH ?? "");
await startHid(bridge, {
  path: hidPath || undefined,
  auto: hasFlag("--hid") || hasFlag("--hid=auto") || process.env.HID_AUTO === "1",
  expo: argNum("--hid-expo", 0.2),
  deadband: argNum("--hid-deadband", 0.05),
  throttlePreset: arg("--hid-throttle", "mode2") === "triggers" ? "triggers" : "mode2",
  generic: { axes: [1, 2, 3, 4], center: 128, halfRange: 127 },
});

await bridge.start();
console.log(`bridge up: tx=${opts.txPort}@${opts.txBaud} fc=${opts.fcPort}@${opts.fcBaud} ws=:${opts.wsPort}`);
console.log(`UI optioneel: frontend verbinden met ws://localhost:${opts.wsPort}`);
console.log("Xbox-pad: via frontend (Gamepad-API). Headless HID: --hid / --hid=/dev/hidraw0");

process.on("SIGINT", () => {
  void bridge.stop().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void bridge.stop().finally(() => process.exit(0));
});
