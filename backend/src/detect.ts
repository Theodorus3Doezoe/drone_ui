// Auto-detectie van de twee seriële poorten via `SerialPort.list()`.
// FC (RP2350 USB-CDC): VID 0xc0de / PID 0xcafe, "RatelDynamics"/"FlightController"
//   -> zeer distinctief, sterke match.
// TX (LilyGO TTGO LoRa32 als ELRS-TX): USB-UART-bruggetje, meestal CP210x
//   (10c4:ea60) of CH340 (1a86:7523), soms FTDI (0403:6001). Zwakkere heuristiek:
//   een sterk FC-gematchte poort wordt nooit als TX gekozen.
import { SerialPort } from "serialport";

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

/** "auto" (of leeg) -> detectie; expliciete waarde wint altijd. */
export async function resolvePorts(
  txReq: string,
  fcReq: string,
  txFallback = "/dev/ttyUSB0",
  fcFallback = "/dev/ttyACM0",
): Promise<{ txPort: string; fcPort: string }> {
  const needDetect = txReq === "auto" || fcReq === "auto" || !txReq || !fcReq;
  const detected = needDetect ? await detectPorts().catch(() => ({ tx: null, fc: null })) : { tx: null, fc: null };
  let txPort = txReq && txReq !== "auto" ? txReq : (detected.tx?.path ?? txFallback);
  let fcPort = fcReq && fcReq !== "auto" ? fcReq : (detected.fc?.path ?? fcFallback);
  if ((!txReq || txReq === "auto") && detected.tx) console.log(`TX auto-detect: ${detected.tx.path} (${detected.tx.reason})`);
  else if (!txReq || txReq === "auto") console.warn(`TX niet gevonden, fallback ${txPort} (geef --tx-port mee)`);
  if ((!fcReq || fcReq === "auto") && detected.fc) console.log(`FC auto-detect: ${detected.fc.path} (${detected.fc.reason})`);
  else if (!fcReq || fcReq === "auto") console.warn(`FC niet gevonden, fallback ${fcPort} (geef --fc-port mee)`);
  return { txPort, fcPort };
}
