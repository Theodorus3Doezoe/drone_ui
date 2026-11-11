// Auto-detectie van de twee seriële poorten via `SerialPort.list()`.
// FC (RP2350 USB-CDC): VID 0xc0de / PID 0xcafe, "RatelDynamics"/"FlightController"
//   -> zeer distinctief, sterke match.
// TX (LilyGO TTGO LoRa32 als ELRS-TX): USB-UART-bruggetje, meestal CP210x
//   (10c4:ea60) of CH340 (1a86:7523), soms FTDI (0403:6001). Zwakkere heuristiek:
//   een sterk FC-gematchte poort wordt nooit als TX gekozen.
import { SerialPort } from "serialport";
import { CRSF_MID, encodeRcChannels, parseCrsfStream } from "@ground-station/shared";

export interface DetectedPort {
  path: string;
  reason: string;
}

interface Info {
  path: string;
  manufacturer?: string;
  productId?: string;
  vendorId?: string;
  serialNumber?: string;
}

const norm = (s?: string) => (s ?? "").toLowerCase();

function isFcPort(p: Info): string | null {
  if (norm(p.vendorId) === "c0de" && norm(p.productId) === "cafe") return "VID:PID c0de:cafe (FC)";
  if (norm(p.manufacturer).includes("ratel")) return `fabrikant ${p.manufacturer} (FC)`;
  if (norm(p.productId).includes("flightcontroller")) return `product ${p.productId} (FC)`;
  return null;
}

function txScore(p: Info): { score: number; reason: string } | null {
  const vid = norm(p.vendorId);
  const pid = norm(p.productId);
  const man = norm(p.manufacturer);
  if (vid === "10c4" && pid === "ea60") return { score: 80, reason: "CP210x USB-UART (TX)" };
  if (vid === "1a86" && (pid === "7523" || pid === "5523")) return { score: 80, reason: "CH340 USB-UART (TX)" };
  if (vid === "0403" && pid === "6001") return { score: 70, reason: "FTDI USB-UART (TX)" };
  if (man.includes("silicon labs") || man.includes("wch") || man.includes("ftdi") || man.includes("cp210") || man.includes("ch340")) {
    return { score: 60, reason: `UART-brug ${p.manufacturer} (TX)` };
  }
  return null;
}

/** Pure selectie — testbaar zonder hardware. */
export function pickPorts(ports: Info[]): { tx: DetectedPort | null; fc: DetectedPort | null } {
  let fc: DetectedPort | null = null;
  for (const p of ports) {
    const reason = isFcPort(p);
    if (reason) {
      fc = { path: p.path, reason };
      break;
    }
  }
  let tx: DetectedPort | null = null;
  let best = 0;
  for (const p of ports) {
    if (fc && p.path === fc.path) continue; // FC-poort nooit als TX gebruiken
    const s = txScore(p);
    if (s && s.score > best) {
      best = s.score;
      tx = { path: p.path, reason: s.reason };
    }
  }
  return { tx, fc };
}

export async function detectPorts(): Promise<{ tx: DetectedPort | null; fc: DetectedPort | null }> {
  const list = (await SerialPort.list()) as Info[];
  return pickPorts(list.filter((p) => p.path));
}

/** "auto" (of leeg) -> detectie; "off"/"none" -> uit; rest is letterlijk pad. */
export async function resolveTxPort(req: string, quiet = false): Promise<string> {
  if (req === "off" || req === "none") return "";
  if (req && req !== "auto") return req;
  const found = await pickTxPort().catch(() => null);
  if (found) {
    if (!quiet) console.log(`TX auto: ${found.path} (${found.reason})`);
    return found.path;
  }
  if (!quiet) console.log("TX niet gevonden — probeer opnieuw zodra een apparaat verschijnt (of geef --tx-port mee)");
  return "";
}

/** Zelfde voor FC, maar zónder zwakke heuristiek: nooit zomaar een ACM-poort pakken. */
export async function resolveFcPort(req: string, quiet = false): Promise<string> {
  if (req === "off" || req === "none") return "";
  if (req && req !== "auto") return req;
  const { fc } = await detectPorts().catch(() => ({ tx: null, fc: null as null }));
  if (fc?.path) {
    if (!quiet) console.log(`FC auto: ${fc.path} (${fc.reason})`);
    return fc.path;
  }
  if (!quiet) console.log("FC niet gevonden — sla over tot hij verschijnt (of geef --fc-port mee)");
  return "";
}

/** Open kandidaat op 921600, stuur neutrale RC-frames, check op 0x3A-sync (alleen een TX doet dat). */
async function probeTxCandidate(path: string): Promise<boolean> {
  const port = new SerialPort({ path, baudRate: 921600, autoOpen: false });
  // Zonder error-listener crasht Node op elk serieel-foutje (unhandled 'error' event).
  port.on("error", () => {
    /* genegeerd — probe faalt zacht via found=false */
  });
  try {
    await Promise.race([
      port.open(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("open-timeout")), 2000)),
    ]);
  } catch {
    return false;
  }
  let found = false;
  let rest: Uint8Array = new Uint8Array(0);
  const frame = Buffer.from(encodeRcChannels(new Array(16).fill(CRSF_MID)));
  port.on("data", (d: Buffer) => {
    const bytes = new Uint8Array(d.length);
    bytes.set(d);
    const buf = new Uint8Array(rest.length + bytes.length);
    buf.set(rest, 0);
    buf.set(bytes, rest.length);
    try {
      const r = parseCrsfStream(buf);
      rest = r.rest;
      if (r.frames.some((f) => f.type === 0x3a)) found = true;
    } catch {
      rest = new Uint8Array(0);
    }
  });
  try {
    for (let i = 0; i < 8 && !found; i++) {
      await port.write(frame);
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!found) await new Promise((r) => setTimeout(r, 300));
  } catch {
    /* genegeerd — kandidaat telt niet mee */
  }
  try {
    await port.close();
  } catch {
    /* al dicht of nooit open geweest */
  }
  return found;
}

/** Kies TX-poort: bij meerdere CP210x-kandidaten proben welke echt een TX is. */
export async function pickTxPort(): Promise<DetectedPort | null> {
  let list: Info[] = [];
  try {
    list = ((await SerialPort.list()) as Info[]).filter((p) => p.path);
  } catch {
    return null;
  }
  const scored = list
    .map((p) => ({ p, s: txScore(p) }))
    .filter((x): x is { p: Info; s: NonNullable<ReturnType<typeof txScore>> } => x.s !== null)
    .sort((a, b) => b.s.score - a.s.score);
  if (scored.length === 0) return null;
  if (scored.length === 1) return { path: scored[0].p.path!, reason: `${scored[0].s.reason} (enige kandidaat)` };
  for (const { p } of scored) {
    console.log(`TX-probe ${p.path}: 0x16 sturen, wachten op 0x3A-sync...`);
    if (await probeTxCandidate(p.path!)) return { path: p.path!, reason: "USB-UART + antwoordt op CRSF" };
  }
  return { path: scored[0].p.path!, reason: `${scored[0].s.reason} (geen antwoord, toch proberen)` };
}

/** "auto" (of leeg) -> detectie; expliciete waarde wint altijd; "off" -> leeg. */
export async function resolvePorts(
  txReq: string,
  fcReq: string,
): Promise<{ txPort: string; fcPort: string }> {
  const [txPort, fcPort] = await Promise.all([resolveTxPort(txReq), resolveFcPort(fcReq)]);
  return { txPort, fcPort };
}
