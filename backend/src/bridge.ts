import {
  BackendToPc,
  CH_ARM,
  CH_MODE,
  CH_PITCH,
  CH_ROLL,
  CH_THROTTLE,
  CH_YAW,
  CRSF_MID,
  CRSF_TYPE_TELEMETRY,
  LinkStats,
  LogLevel,
  PcToBackend,
  SYSTEM_STATE_NAMES,
  decodeLinkStats,
  decodeTelemetry7B,
  encodeCrsfTune,
  encodeTuningPing,
  isValidTxBaud,
  TX_BAUD_MAX,
  TX_BAUD_MIN,
  parsePingPayload,
  encodeFromPc,
  encodeRcChannels,
  parseCrsfStream,
  parseToPcStream,
  stickToCrsf,
  switchToCrsf,
  throttleToCrsf,
  type RxSightKind,
} from "@ground-station/shared";
import { SerialPort } from "serialport";
import { WebSocketServer, WebSocket } from "ws";
import { resolveFcPort, resolveTxPort } from "./detect.js";

export interface BridgeOptions {
  txPort: string;
  fcPort: string;
  txReq: string;
  fcReq: string;
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
  private watch: NodeJS.Timeout | null = null;
  private txOpening = false;
  private fcOpening = false;
  private lastTxAttempt = 0;
  private lastFcAttempt = 0;
  private lastTxWarn = 0;
  private lastFcWarn = 0;
  // ELRS-tuning heartbeat: 1Hz ping via TX, echo komt terug als 0x7B/0x7F03.
  private pingSeq = 0;
  private lastPingSentAt = 0;
  private pendingPing: { seq: number; at: number } | null = null;
  private pingRttMs: number | null = null;
  // Tuning via de ELRS-link: frames één voor één met kleine tussenruimte, zodat
  // de ELRS-MSP-uplink (TX/RX) niet vier frames tegelijk hoeft te bufferen.
  private tuneQueue: Uint8Array[] = [];
  private tuneTimer: NodeJS.Timeout | null = null;

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

  /** RX-inspector: één waarneming, gecapt (max 12 per data-event tegen WS-vloed). */
  private rxBudget = 0;
  /** Start bij epoch-ms zodat ids ook na een backend-restart oplopen. */
  private rxSeq = Date.now();
  private rxSight(
    port: "tx" | "fc",
    ok: boolean,
    label: string,
    bytes: Uint8Array | number[],
    note?: string,
    kind: RxSightKind = "other",
  ): void {
    if (this.rxBudget <= 0) return;
    this.rxBudget--;
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.broadcast({
      t: "rx",
      sight: {
        port,
        id: ++this.rxSeq,
        at: Date.now(),
        ok,
        kind: ok ? kind : "error",
        label,
        bytes: [...b.slice(0, 48)],
        ...(note !== undefined ? { note } : {}),
      },
    });
  }

  private hex(bytes: Uint8Array | number[]): string {
    const b = bytes instanceof Uint8Array ? [...bytes] : bytes;
    return b.map((x) => x.toString(16).padStart(2, "0")).join(" ");
  }

  statusMessage(): BackendToPc {
    return {
      t: "status",
      tx: { name: this.tx?.path ?? this.opts.txPort, baud: this.opts.txBaud, open: this.tx?.isOpen ?? false, error: this.txError },
      fc: { name: this.fc?.path ?? this.opts.fcPort, baud: this.opts.fcBaud, open: this.fc?.isOpen ?? false, error: this.fcError },
      bridgeHz: this.bridgeHz,
      inputAgeMs: this.input.receivedAt ? Date.now() - this.input.receivedAt : null,
      corruptFrames: this.corruptFrames,
      fcSupported: this.fcSupported,
      txUpBytes: this.txUpBytes,
      txDownBytes: this.txDownBytes,
      pingRttMs: this.pingRttMs,
    };
  }

  async start(): Promise<void> {
    void this.openTx();
    void this.openFc();
    // Watcher: apparaat (her)verschijnt of verdwijnt -> automatisch (her)openen.
    // Her-detecteert "auto"-poorten bij elke poging; hooguit 1 poging per 3s,
    // waarschuwing hooguit 1x per 30s (geen logspam).
    this.watch = setInterval(() => {
      const now = Date.now();
      if (this.txReqOn() && (!this.tx || !this.tx.isOpen) && now - this.lastTxAttempt > 3000) {
        void this.openTx();
      }
      if (this.fcReqOn() && (!this.fc || !this.fc.isOpen) && now - this.lastFcAttempt > 3000) {
        void this.openFc();
      }
    }, 2500);
    this.watch.unref?.();
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
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    await this.closePort(this.tx);
    await this.closePort(this.fc);
    this.tx = null;
    this.fc = null;
  }

  private txReqOn(): boolean {
    return this.opts.txReq !== "off" && this.opts.txReq !== "none";
  }

  private fcReqOn(): boolean {
    return this.opts.fcReq !== "off" && this.opts.fcReq !== "none";
  }

  private closePort(p: SerialPort | null): Promise<void> {
    return new Promise((resolve) => {
      if (!p || !p.isOpen) return resolve();
      p.close(() => resolve());
    });
  }

  reconnect(port: "tx" | "fc"): void {
    // Forceer een verse detectie (geen throttle): pakt het juiste apparaat,
    // ook als poorten zijn verschoven sinds de start.
    if (port === "tx") {
      this.bannerSent.tx = false;
      this.lastTxAttempt = 0;
      void this.openTx();
    } else {
      this.bannerSent.fc = false;
      this.lastFcAttempt = 0;
      void this.openFc();
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
    } else if (msg.t === "tune") {
      this.sendTune((msg as { cmd: Parameters<typeof encodeCrsfTune>[0] }).cmd);
    } else if (msg.t === "reconnect") {
      this.reconnect(msg.port);
    } else if (msg.t === "setTxBaud") {
      this.setTxBaud((msg as { baud: unknown }).baud);
    }
  }

  /** TX-baud live omzetten: poort gaat dicht en opnieuw open op de nieuwe snelheid. */
  setTxBaud(baud: unknown): void {
    if (!isValidTxBaud(baud)) {
      this.log("warn", `TX-baud genegeerd (ongeldig: ${String(baud)}, geldig ${TX_BAUD_MIN}..${TX_BAUD_MAX})`);
      return;
    }
    if (baud === this.opts.txBaud && this.tx?.isOpen) {
      this.log("info", `TX-baud al ${baud} — niets te doen`);
      return;
    }
    this.opts.txBaud = baud;
    this.log("info", `TX-baud -> ${baud}, poort opnieuw openen…`);
    this.reconnect("tx");
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

  /** Live tuning via de ELRS-link (0x7A extended frames), niet via FC-USB. */
  sendTune(cmd: Parameters<typeof encodeCrsfTune>[0]): void {
    if (!this.tx?.isOpen) {
      this.log("warn", "TX-poort dicht, tuning genegeerd");
      return;
    }
    try {
      this.tuneQueue.push(encodeCrsfTune(cmd));
      this.flushTuneQueue();
    } catch (err) {
      this.log("error", `tuning encode failed: ${(err as Error).message}`);
    }
  }

  private flushTuneQueue(): void {
    if (this.tuneTimer) return;
    const step = (): void => {
      const tx = this.tx;
      if (!tx?.isOpen || this.tuneQueue.length === 0) {
        this.tuneQueue.length = 0;
        this.tuneTimer = null;
        return;
      }
      const bytes = this.tuneQueue.shift()!;
      tx.write(Buffer.from(bytes), (err) => {
        if (err) this.log("error", `TX tuning write failed: ${err.message}`);
      });
      this.txUpBytes += bytes.length;
      // ±25 Hz: snel genoeg voor de UI, rustig genoeg voor de ELRS-MSP-queue.
      this.tuneTimer = setTimeout(step, 40);
    };
    step();
  }

  private tick(): void {
    // Failsafe in twee trappen. Geen verse input (tab verborgen, pad weg):
    // blijf de LAATSTE input sturen zodat de link in leven blijft (net als een
    // echte zender, die ook nooit stilvalt als je wegkijkt). Pas bij >5s totale
    // stilte of verbroken WS-verbinding volledig stoppen (= failsafe via RX-timeout).
    // De UI toont STALE zodra input ouder is dan 500ms.
    if (!this.hidOk) return;
    if (!this.tx?.isOpen) return;
    // Heartbeat (1Hz) los van stick-input: bewijst de hele keten
    // PC -> TX-module -> lucht -> RX -> FC -> terug, en levert RTT.
    // Ping draagt geen besturing (FC echoot alleen), dus ook zonder verse input.
    const nowMs = Date.now();
    if (nowMs - this.lastPingSentAt >= 1000) {
      this.lastPingSentAt = nowMs;
      const seq = (this.pingSeq = (this.pingSeq + 1) & 0xffff);
      try {
        const frame = encodeTuningPing(seq, nowMs, Math.floor(Math.random() * 0x10000));
        this.tx.write(Buffer.from(frame));
        this.txUpBytes += frame.length;
        this.pendingPing = { seq, at: nowMs };
      } catch (err) {
        this.log("warn", `ping encode failed: ${(err as Error).message}`);
      }
    }
    const age = nowMs - this.input.receivedAt;
    if (!this.input.receivedAt || age > 5000) return; // geen verse input

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

  private async openTx(): Promise<void> {
    if (this.txOpening || !this.txReqOn()) return;
    this.txOpening = true;
    this.lastTxAttempt = Date.now();
    try {
      const path = await resolveTxPort(this.opts.txReq, true);
      if (!path) return; // stil: watcher probeert opnieuw
      await this.closePort(this.tx);
      if (this.tx?.isOpen) return; // intussen al open (race met watcher)
      const port = new SerialPort({ path, baudRate: this.opts.txBaud, autoOpen: false });
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
          this.warnThrottled("tx", `TX ${path} niet te openen (${err.message}) — blijf proberen`);
        } else {
          this.txError = undefined;
          this.bannerSent.tx = false;
          this.log("info", `TX-poort open: ${path} @ ${this.opts.txBaud}`);
          this.broadcast(this.statusMessage());
        }
      });
    } finally {
      this.txOpening = false;
    }
  }

  /** Waarschuwing hooguit 1x per 30s (geen logspam bij afwezige hardware). */
  private warnThrottled(port: "tx" | "fc", message: string): void {
    const now = Date.now();
    if (port === "tx") {
      if (now - this.lastTxWarn < 30000) return;
      this.lastTxWarn = now;
    } else {
      if (now - this.lastFcWarn < 30000) return;
      this.lastFcWarn = now;
    }
    this.log("warn", message);
  }

  private async openFc(): Promise<void> {
    if (this.fcOpening || !this.fcReqOn()) return;
    this.fcOpening = true;
    this.lastFcAttempt = Date.now();
    try {
      const path = await resolveFcPort(this.opts.fcReq, true);
      if (!path) return; // stil: watcher probeert opnieuw
      await this.closePort(this.fc);
      if (this.fc?.isOpen) return;
      const port = new SerialPort({ path, baudRate: this.opts.fcBaud, autoOpen: false });
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
          this.warnThrottled("fc", `FC ${path} niet te openen (${err.message}) — blijf proberen`);
        } else {
          this.fcError = undefined;
          this.bannerSent.fc = false;
          this.log("info", `FC-poort open: ${path} @ ${this.opts.fcBaud}`);
          this.broadcast(this.statusMessage());
        }
      });
    } finally {
      this.fcOpening = false;
    }
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
      if (/^[\x20-\x7e]{3,200}$/.test(clean)) {
        this.log("debug", `[TX] ${clean}`);
        this.rxSight("tx", true, "usb-tekst", [], clean.slice(0, 120));
      }
    }
    this.txRest = concat(this.txRest, data);
    try {
      const { frames, rest, corrupt, bad } = parseCrsfStream(this.txRest);
      this.txRest = rest;
      this.corruptFrames += corrupt;
      this.rxBudget = 12;
      for (const b of bad) {
        const what = b.reason === "bad-crc" ? "CRC-fout" : "lengte-fout";
        const where = b.type !== undefined ? ` type 0x${b.type.toString(16)}` : "";
        this.rxSight("tx", false, `${what}${where}`, b.bytes, `len=${b.len ?? "?"} bytes=${this.hex(b.bytes)}`);
      }
      for (const f of frames) {
        if (f.type === 0x14) {
          const stats: LinkStats | null = decodeLinkStats(f.payload);
          if (stats) this.broadcast({ t: "link", stats });
          this.rxSight(
            "tx",
            true,
            "0x14 link-stats",
            f.payload,
            stats ? `up ${stats.uplinkRssiDbm}dBm/${stats.uplinkLq}% down ${stats.downlinkRssiDbm}dBm/${stats.downlinkLq}%` : "te kort (<10B)",
            "link",
          );
        } else if (f.type === CRSF_TYPE_TELEMETRY) {
          // 0x7B-antwoorden van de FC (via ELRS TX-USB): ping-echo (0x7F03) of TunAck (0x7F04).
          try {
            const tele = decodeTelemetry7B(f.payload);
            if (!tele) {
              this.log("warn", "0x7B-frame te kort (<2B, geen sub-id)");
              this.rxSight("tx", false, "0x7B te kort", f.payload, "geen sub-id (<2B)");
            } else if (tele.kind === "ping") {
              const bytes = [...tele.bytes];
              const echo = parsePingPayload(tele.bytes);
              let rtt: number | null = null;
              if (echo && this.pendingPing && echo.seq === this.pendingPing.seq) {
                rtt = Date.now() - this.pendingPing.at;
                this.pingRttMs = rtt;
                this.pendingPing = null;
              }
              this.broadcast({ t: "ping", seq: echo?.seq ?? -1, bytes, rttMs: rtt });
              this.rxSight("tx", true, "0x7B ping-echo", f.payload, `seq=${echo?.seq ?? "?"}${rtt !== null ? ` RTT ${rtt}ms` : " (geen match)"}`, "ping");
            } else if (tele.kind === "tunack") {
              this.lastAckAt = Date.now();
              this.fcSupported = true;
              this.broadcast({ t: "tunack", ack: tele.ack });
              const a = tele.ack;
              this.rxSight(
                "tx",
                true,
                "0x7B TunAck",
                f.payload,
                a.kind === "pid"
                  ? `pid as${a.axis} kp=${a.kp} ki=${a.ki} kd=${a.kd} ok=${a.ok}`
                  : `filter gyro=${a.gyro} lpf1=${a.lpf1} lpf2=${a.lpf2} ok=${a.ok}`,
                "tunack",
              );
            } else {
              this.log("debug", `onbekende 0x7B-sub 0x${tele.sub.toString(16)} genegeerd`);
              this.rxSight("tx", true, `0x7B sub 0x${tele.sub.toString(16)}`, f.payload, "onbekende sub, genegeerd");
            }
          } catch (err) {
            this.log("warn", `TunAck gedropt: ${(err as Error).message}`);
            this.rxSight("tx", false, "0x7B decode-fout", f.payload, (err as Error).message);
          }
        } else {
          // 0x3A = ELRS handset-timing/radio-ID, normaal op RC-packetrate.
          const radio = f.type === 0x3a;
          const label = radio
            ? "0x3A radio-ID/handset-timing"
            : `0x${f.type.toString(16).padStart(2, "0")} overig`;
          const note = radio
            ? `${f.payload.length}B ELRS timing/offset (normaal, genegeerd)`
            : `${f.payload.length}B genegeerd`;
          this.rxSight("tx", true, label, f.payload, note, radio ? "radio" : "other");
        }
      }
    } catch {
      this.txRest = new Uint8Array(0);
    }
    if (this.txRest.length > 512) this.txRest = new Uint8Array(0);
  }

  private onFcData(data: Uint8Array): void {
    this.fcRest = concat(this.fcRest, data);
    this.rxBudget = 12;
    try {
      const { messages, rest } = parseToPcStream(this.fcRest);
      this.fcRest = rest;
      for (const { msg: m, raw } of messages) {
        if (m.kind === "attitude") {
          // Decimeren naar ±20Hz voor de websocket.
          const now = Date.now();
          if (now - this.lastAttitudePush >= 50) {
            this.lastAttitudePush = now;
            this.broadcast({ t: "attitude", roll: m.roll, pitch: m.pitch, yaw: m.yaw });
          }
          this.rxSight("fc", true, "postcard attitude", raw, `R=${m.roll.toFixed(3)} P=${m.pitch.toFixed(3)} Y=${m.yaw.toFixed(3)}`, "fc");
        } else if (m.kind === "systemState") {
          this.broadcast({
            t: "system",
            state: m.state,
            stateName: SYSTEM_STATE_NAMES[m.state] ?? `UNKNOWN(${m.state})`,
            armBlocks: m.armBlocks,
            errors: m.errors,
          });
          this.rxSight("fc", true, "postcard system", raw, `state=${m.state} armBlocks=${m.armBlocks} errors=${m.errors}`, "fc");
        } else if (m.kind === "ack") {
          this.lastAckAt = Date.now();
          this.fcSupported = true;
          this.broadcast({ t: "ack" });
          this.rxSight("fc", true, "postcard ack", raw, "FC Ack (USB-CDC)", "fc");
        } else {
          this.broadcast({ t: "log", level: "info", message: `[FC] ${m.message}` });
          this.rxSight("fc", true, "postcard log", raw, m.message.slice(0, 120), "fc");
        }
      }
    } catch (err) {
      this.corruptFrames += 1;
      this.rxSight("fc", false, "postcard decode-fout", this.fcRest.slice(0, 48), (err as Error).message);
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
