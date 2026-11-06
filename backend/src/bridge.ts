import {
  BackendToPc,
  CH_ARM,
  CH_MODE,
  CH_PITCH,
  CH_ROLL,
  CH_THROTTLE,
  CH_YAW,
  CRSF_MID,
  LinkStats,
  LogLevel,
  PcToBackend,
  SYSTEM_STATE_NAMES,
  decodeLinkStats,
  encodeFromPc,
  encodeRcChannels,
  parseCrsfStream,
  parseToPcStream,
  stickToCrsf,
  switchToCrsf,
  throttleToCrsf,
} from "@ground-station/shared";
import { SerialPort } from "serialport";
import { WebSocketServer, WebSocket } from "ws";

export interface BridgeOptions {
  txPort: string;
  fcPort: string;
  txBaud: number;
  fcBaud: number;
  wsPort: number;
  hidPath?: string;
  bridgeHz?: number;
}

export interface PilotInput {
  roll: number;
  pitch: number;
  throttle: number; // 0..1
  yaw: number;
  modeRate: boolean;
  armed: boolean;
  receivedAt: number;
}

const DEFAULT_INPUT: PilotInput = {
  roll: 0,
  pitch: 0,
  throttle: 0,
  yaw: 0,
  modeRate: false,
  armed: false,
  receivedAt: 0,
};

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export class Bridge {
  private tx: SerialPort | null = null;
  private fc: SerialPort | null = null;
  private txRest: Uint8Array = new Uint8Array(0);
  private fcRest: Uint8Array = new Uint8Array(0);
  private txError: string | undefined;
  private fcError: string | undefined;
  private input: PilotInput = { ...DEFAULT_INPUT };
  private hidOk = true;
  private hidError: string | undefined;
  private lastFrameAt = 0;
  private frameCount = 0;
  private bridgeHz = 0;
  private corruptFrames = 0;
  private lastChannels: number[] = new Array(16).fill(CRSF_MID);
  private lastChPush = 0;
  private txUpBytes = 0;
  private txDownBytes = 0;
  private txTextBuf = "";
  private lastDiagAt = 0;
  private lastAckAt = 0;
  private fcSupported = false;
  private lastAttitudePush = 0;
  private logListeners = new Set<(msg: BackendToPc) => void>();
  private bannerSent = { tx: false, fc: false, hid: false };
  private loop: NodeJS.Timeout | null = null;

  constructor(private opts: BridgeOptions) {}

  onBroadcast(fn: (msg: BackendToPc) => void): () => void {
    this.logListeners.add(fn);
    return () => {
      this.logListeners.delete(fn);
    };
  }

  private broadcast(msg: BackendToPc): void {
    for (const fn of this.logListeners) {
      try {
        fn(msg);
      } catch {
        /* ignore */
      }
    }
  }

  private log(level: LogLevel, message: string): void {
    this.broadcast({ t: "log", level, message });
  }

  statusMessage(): BackendToPc {
    return {
      t: "status",
      tx: { name: this.opts.txPort, baud: this.opts.txBaud, open: this.tx?.isOpen ?? false, error: this.txError },
      fc: { name: this.opts.fcPort, baud: this.opts.fcBaud, open: this.fc?.isOpen ?? false, error: this.fcError },
      bridgeHz: this.bridgeHz,
      inputAgeMs: this.input.receivedAt ? Date.now() - this.input.receivedAt : null,
      corruptFrames: this.corruptFrames,
      fcSupported: this.fcSupported,
      txUpBytes: this.txUpBytes,
      txDownBytes: this.txDownBytes,
    };
  }

  async start(): Promise<void> {
    this.openTx();
    this.openFc();
    const periodMs = 1000 / (this.opts.bridgeHz ?? 150);
    let lastHzCount = 0;
    let lastHzAt = Date.now();
    // Zelf-plannende keten tegen een absolute tijdlijn i.p.v. setInterval:
    // setInterval laat elke event-loop-vertraging in de cadans stapelen,
    // dit houdt het gemiddelde exact op bridgeHz (jitter per tick blijft).
    let tickCount = 0;
    const t0 = Date.now();
    const step = (): void => {
      if (!this.loop) return; // gestopt
      try {
        this.tick();
      } catch (err) {
        this.log("error", `bridge tick failed: ${(err as Error).message}`);
      }
      tickCount++;
      const now = Date.now();
      if (now - lastHzAt >= 1000) {
        this.bridgeHz = this.frameCount - lastHzCount;
        lastHzCount = this.frameCount;
        lastHzAt = now;
        this.broadcast(this.statusMessage());
        if (now - this.lastDiagAt >= 5000) {
          this.lastDiagAt = now;
          this.log(
            "info",
            `TX: ${this.bridgeHz} frames/s verstuurd, ${this.txUpBytes}B heen / ${this.txDownBytes}B terug`,
          );
        }
      }
      // Kanalen vlot naar de UI (±30Hz) i.p.v. 1Hz — anders voelt alles log aan.
      if (now - this.lastChPush >= 33 && this.lastFrameAt > 0) {
        this.lastChPush = now;
        this.broadcast({ t: "channels", ch: [...this.lastChannels], hz: this.bridgeHz });
      }
      if (!this.loop) return; // gestopt tijdens tick
      this.loop = setTimeout(step, Math.max(0, t0 + tickCount * periodMs - Date.now()));
    };
    this.loop = setTimeout(step, periodMs);
    this.loop.unref?.();
  }

  async stop(): Promise<void> {
    if (this.loop) clearTimeout(this.loop);
    this.loop = null;
    await this.closePort(this.tx);
    await this.closePort(this.fc);
    this.tx = null;
    this.fc = null;
  }

  private closePort(p: SerialPort | null): Promise<void> {
    return new Promise((resolve) => {
      if (!p || !p.isOpen) return resolve();
      p.close(() => resolve());
    });
  }

  reconnect(port: "tx" | "fc"): void {
    if (port === "tx") {
      this.bannerSent.tx = false;
      this.openTx();
    } else {
      this.bannerSent.fc = false;
      this.openFc();
    }
  }

  handlePcMessage(raw: string): void {
    let msg: PcToBackend;
    try {
      msg = JSON.parse(raw) as PcToBackend;
    } catch {
      return;
    }
    if (msg.t === "input") {
      this.setInput(msg.roll, msg.pitch, msg.throttle, msg.yaw, msg.modeRate, msg.armed);
    } else if (msg.t === "fc") {
      this.sendFc(msg.cmd && (msg as { cmd: Parameters<typeof encodeFromPc>[0] }).cmd);
    } else if (msg.t === "reconnect") {
      this.reconnect(msg.port);
    }
  }

  setInput(roll: number, pitch: number, throttle: number, yaw: number, modeRate: boolean, armed: boolean): void {
    const clamp = (v: number, lo: number, hi: number) =>
      Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : 0));
    this.input = {
      roll: clamp(roll, -1, 1),
      pitch: clamp(pitch, -1, 1),
      throttle: clamp(throttle, 0, 1),
      yaw: clamp(yaw, -1, 1),
      modeRate,
      armed,
      receivedAt: Date.now(),
    };
    if (!this.bannerSent.hid) {
      this.hidOk = true;
    }
  }

  /** node-hid fallback kan dit aanroepen; bij verlies failsafe via markHidLost(). */
  setHidLost(message: string): void {
    this.hidOk = false;
    this.hidError = message;
    if (!this.bannerSent.hid) {
      this.bannerSent.hid = true;
      this.broadcast({ t: "banner", port: "hid", message: `Controller weg: ${message}. Zenden gestopt (failsafe).` });
      this.log("error", `HID verloren: ${message}`);
    }
  }

  sendFc(cmd: Parameters<typeof encodeFromPc>[0]): void {
    if (!this.fc?.isOpen) {
      this.log("warn", "FC-poort dicht, commando genegeerd");
      return;
    }
    try {
      const bytes = encodeFromPc(cmd);
      this.fc.write(Buffer.from(bytes), (err) => {
        if (err) this.log("error", `FC write failed: ${err.message}`);
        else if (cmd.kind === "setPid" || cmd.kind === "setFilter") {
          // Defensief: FC implementeert tuning later pas — Ack kan uitblijven.
          setTimeout(() => {
            if (Date.now() - this.lastAckAt > 500 && !this.fcSupported) {
              this.log("warn", "Geen Ack van FC — FC ondersteunt tuning (nog) niet");
            }
          }, 600);
        }
      });
    } catch (err) {
      this.log("error", `FC encode failed: ${(err as Error).message}`);
    }
  }

  private tick(): void {
    // Failsafe: bij HID- of serieel-verlies direct stoppen met zenden
    // (= failsafe via RX-timeout op de FC).
    if (!this.hidOk) return;
    if (!this.tx?.isOpen) return;
    const age = Date.now() - this.input.receivedAt;
    if (!this.input.receivedAt || age > 500) return; // geen verse input

    const ch = new Array(16).fill(CRSF_MID);
    ch[CH_ROLL] = stickToCrsf(this.input.roll);
    ch[CH_PITCH] = stickToCrsf(this.input.pitch);
    ch[CH_THROTTLE] = throttleToCrsf(this.input.throttle);
    ch[CH_YAW] = stickToCrsf(this.input.yaw);
    ch[CH_MODE] = switchToCrsf(this.input.modeRate);
    ch[CH_ARM] = switchToCrsf(this.input.armed);

    const frame = encodeRcChannels(ch);
    this.tx.write(Buffer.from(frame));
    this.txUpBytes += frame.length;
    this.lastChannels = ch;
    this.frameCount++;
    this.lastFrameAt = Date.now();
  }

  private openTx(): void {
    this.closePort(this.tx).finally(() => {
      const port = new SerialPort({ path: this.opts.txPort, baudRate: this.opts.txBaud, autoOpen: false });
      this.tx = port;
      this.txError = undefined;
      port.on("data", (d: Buffer) => this.onTxData(new Uint8Array(d)));
      port.on("error", (err) => {
        this.txError = err.message;
        this.onPortLost("tx", err.message);
      });
      port.on("close", () => {
        if (!this.txError) this.txError = "gesloten";
        this.onPortLost("tx", this.txError);
      });
      port.open((err) => {
        if (err) {
          this.txError = err.message;
          this.onPortLost("tx", err.message);
        } else {
          this.txError = undefined;
          this.log("info", `TX-poort open: ${this.opts.txPort} @ ${this.opts.txBaud}`);
          this.broadcast(this.statusMessage());
        }
      });
    });
  }

  private openFc(): void {
    this.closePort(this.fc).finally(() => {
      const port = new SerialPort({ path: this.opts.fcPort, baudRate: this.opts.fcBaud, autoOpen: false });
      this.fc = port;
      this.fcError = undefined;
      port.on("data", (d: Buffer) => this.onFcData(new Uint8Array(d)));
      port.on("error", (err) => {
        this.fcError = err.message;
        this.onPortLost("fc", err.message);
      });
      port.on("close", () => {
        if (!this.fcError) this.fcError = "gesloten";
        this.onPortLost("fc", this.fcError);
      });
      port.open((err) => {
        if (err) {
          this.fcError = err.message;
          this.onPortLost("fc", err.message);
        } else {
          this.fcError = undefined;
          this.log("info", `FC-poort open: ${this.opts.fcPort} @ ${this.opts.fcBaud}`);
          this.broadcast(this.statusMessage());
        }
      });
    });
  }

  private onPortLost(port: "tx" | "fc", message: string): void {
    // Geen auto-reconnect-spam: 1x rode banner, handmatige reconnect-knop in UI.
    if (!this.bannerSent[port]) {
      this.bannerSent[port] = true;
      this.broadcast({ t: "banner", port, message: `Poort ${port} weg: ${message}` });
      this.log("error", `Poort ${port} verloren: ${message} (zenden gestopt, gebruik Reconnect)`);
      this.broadcast(this.statusMessage());
    }
  }

  private onTxData(data: Uint8Array): void {
    this.txDownBytes += data.length;
    // ELRS print bij boot logregels op USB — die tonen we, dan zie je dat de
    // USB-weg richting PC werkt (zegt niets over CRSF-acceptatie).
    this.txTextBuf += new TextDecoder("utf-8", { fatal: false }).decode(data);
    if (this.txTextBuf.length > 2048) this.txTextBuf = this.txTextBuf.slice(-2048);
    const parts = this.txTextBuf.split("\n");
    this.txTextBuf = parts.pop() ?? "";
    for (const line of parts.slice(-5)) {
      const clean = line.replace(/\r/g, "").trim();
      if (/^[\x20-\x7e]{3,200}$/.test(clean)) this.log("debug", `[TX] ${clean}`);
    }
    this.txRest = concat(this.txRest, data);
    try {
      const { frames, rest, corrupt } = parseCrsfStream(this.txRest);
      this.txRest = rest;
      this.corruptFrames += corrupt;
      for (const f of frames) {
        if (f.type === 0x14) {
          const stats: LinkStats | null = decodeLinkStats(f.payload);
          if (stats) this.broadcast({ t: "link", stats });
        }
        // overige telemetrie negeren
      }
    } catch {
      this.txRest = new Uint8Array(0);
    }
    if (this.txRest.length > 512) this.txRest = new Uint8Array(0);
  }

  private onFcData(data: Uint8Array): void {
    this.fcRest = concat(this.fcRest, data);
    try {
      const { messages, rest } = parseToPcStream(this.fcRest);
      this.fcRest = rest;
      for (const m of messages) {
        if (m.kind === "attitude") {
          // Decimeren naar ±20Hz voor de websocket.
          const now = Date.now();
          if (now - this.lastAttitudePush >= 50) {
            this.lastAttitudePush = now;
            this.broadcast({ t: "attitude", roll: m.roll, pitch: m.pitch, yaw: m.yaw });
          }
        } else if (m.kind === "systemState") {
          this.broadcast({
            t: "system",
            state: m.state,
            stateName: SYSTEM_STATE_NAMES[m.state] ?? `UNKNOWN(${m.state})`,
            armBlocks: m.armBlocks,
            errors: m.errors,
          });
        } else if (m.kind === "ack") {
          this.lastAckAt = Date.now();
          this.fcSupported = true;
          this.broadcast({ t: "ack" });
        } else {
          this.broadcast({ t: "log", level: "info", message: `[FC] ${m.message}` });
        }
      }
    } catch (err) {
      this.corruptFrames += 1;
      this.fcRest = new Uint8Array(0);
      this.log("warn", `FC frame gedropt: ${(err as Error).message}`);
    }
    if (this.fcRest.length > 512) this.fcRest = new Uint8Array(0);
  }
}

export function attachWs(wss: WebSocketServer, bridge: Bridge): void {
  wss.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify(bridge.statusMessage()));
    const off = bridge.onBroadcast((msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    });
    ws.on("message", (data) => bridge.handlePcMessage(String(data)));
    ws.on("close", off);
  });
}
