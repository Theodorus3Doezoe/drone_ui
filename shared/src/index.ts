// Gedeelde contracten ground-station <-> FC / ELRS.
// Kanaallayout is een contract met rust_fc/src/receiver/crsf.rs — exact aanhouden.

// ---------------------------------------------------------------- CRSF
export const CRSF_MIN = 172;
export const CRSF_MID = 992;
export const CRSF_MAX = 1811;
export const CRSF_SPAN = CRSF_MAX - CRSF_MID; // 819
export const CRSF_ADDR = 0xc8;
/** CRSF-sync/adreswaarden die als framestart mogen voorkomen. */
export const CRSF_ADDR_RADIO = 0xea; // handset/radio transmitter
export const CRSF_ADDR_RX = 0xec; // receiver
export const CRSF_ADDR_TX = 0xee; // TX-module
export const CRSF_ADDR_BROADCAST = 0x00;

const CRSF_SYNC_ADDRESSES = new Set([CRSF_ADDR, CRSF_ADDR_RADIO, CRSF_ADDR_RX, CRSF_ADDR_TX]);
const CRSF_DEVICE_ADDRESSES = new Set([...CRSF_SYNC_ADDRESSES, CRSF_ADDR_BROADCAST]);

/** True als `b` een CRSF-syncadres is waarmee een frame mag beginnen. */
export function isCrsfSyncAddress(b: number): boolean {
  return CRSF_SYNC_ADDRESSES.has(b);
}

/** True als `b` een bekend CRSF-apparaatadres is (incl. broadcast). */
function isCrsfDeviceAddress(b: number): boolean {
  return CRSF_DEVICE_ADDRESSES.has(b);
}

export const CRSF_TYPE_RC_CHANNELS = 0x16;
export const CRSF_TYPE_LINK_STATS = 0x14;
export const CRSF_FRAME_LEN = 26; // addr+len+type+22B+crc

/** ch1=roll, ch2=pitch, ch3=throttle, ch4=yaw (0-based indices 0..3) */
export const CH_ROLL = 0;
export const CH_PITCH = 1;
export const CH_THROTTLE = 2;
export const CH_YAW = 3;
/** ch5=mode (SA: <=1500 Angle, >1500 Rate) */
export const CH_MODE = 4;
/** ch9=arm (SE: >1500 armed) */
export const CH_ARM = 8;

export const MODE_THRESHOLD = 1500;
export const ARM_THRESHOLD = 1500;

/** Stick -1..1 -> CRSF 172..1811 met midden 992. */
export function stickToCrsf(v: number): number {
  const clamped = Math.min(1, Math.max(-1, v));
  return Math.min(CRSF_MAX, Math.max(CRSF_MIN, Math.round(CRSF_MID + clamped * CRSF_SPAN)));
}

export function crsfToPercent(v: number): number {
  return Math.min(100, Math.max(-100, Math.round(((v - CRSF_MID) / CRSF_SPAN) * 100)));
}

export function throttleToCrsf(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return Math.min(CRSF_MAX, Math.max(CRSF_MIN, Math.round(CRSF_MIN + clamped * (CRSF_MAX - CRSF_MIN))));
}

export function switchToCrsf(on: boolean): number {
  return on ? CRSF_MAX : CRSF_MIN;
}

/** CRC8 DVB-S2, poly 0xD5 — over type+payload. */
export function crc8DvbS2(crc: number, b: number): number {
  crc ^= b;
  for (let i = 0; i < 8; i++) {
    crc = crc & 0x80 ? ((crc << 1) ^ 0xd5) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

export function encodeRcChannels(ch: readonly number[]): Uint8Array {
  if (ch.length !== 16) throw new Error(`need 16 channels, got ${ch.length}`);
  for (const v of ch) {
    if (!Number.isInteger(v) || v < CRSF_MIN || v > CRSF_MAX) {
      throw new Error(`channel out of range 172..1811: ${v}`);
    }
  }
  const payload = new Uint8Array(22);
  let bitpos = 0;
  for (let i = 0; i < 16; i++) {
    let v = ch[i]!;
    for (let b = 0; b < 11; b++) {
      if (v & (1 << b)) payload[bitpos >> 3]! |= 1 << (bitpos & 7);
      bitpos++;
    }
  }
  const frame = new Uint8Array(CRSF_FRAME_LEN);
  frame[0] = CRSF_ADDR;
  frame[1] = 24; // type(1) + payload(22) + crc(1)
  frame[2] = CRSF_TYPE_RC_CHANNELS;
  frame.set(payload, 3);
  let crc = 0;
  for (let i = 2; i < 25; i++) crc = crc8DvbS2(crc, frame[i]!);
  frame[25] = crc;
  return frame;
}

export function decodeRcPayload(payload: Uint8Array): number[] {
  if (payload.length !== 22) throw new Error(`RC payload must be 22B, got ${payload.length}`);
  const out: number[] = [];
  let bitpos = 0;
  for (let i = 0; i < 16; i++) {
    let v = 0;
    for (let b = 0; b < 11; b++) {
      if (payload[bitpos >> 3]! & (1 << (bitpos & 7))) v |= 1 << b;
      bitpos++;
    }
    out.push(v);
  }
  return out;
}

export interface CrsfFrame {
  type: number;
  payload: Uint8Array;
}

export interface CrsfParseResult {
  frames: CrsfFrame[];
  /** Resterende onvolledige bytes (opnieuw aanbieden bij volgende read). */
  rest: Uint8Array;
  corrupt: number;
  /** Afgekeurde kandidaten (max 8 per call) — voor diagnose, met byte-snippet. */
  bad: CrsfReject[];
}

/** Afgekeurd CRSF-frame: reden + snippet van de ruwe bytes (max 16B). */
export interface CrsfReject {
  reason: "bad-len" | "bad-crc";
  type?: number;
  len?: number;
  bytes: number[];
}

/** Incrementele parser: valideer len + CRC, drop corrupte frames met teller.
 *  Afgekeurde kandidaten komen (gecapt) in `bad` terecht i.p.v. stil te verdwijnen. */
export function parseCrsfStream(buf: Uint8Array): CrsfParseResult {
  const frames: CrsfFrame[] = [];
  const bad: CrsfReject[] = [];
  const reject = (r: CrsfReject) => {
    if (bad.length < 8) bad.push(r);
  };
  const snippet = (from: number, n: number): number[] => [...buf.slice(from, Math.min(buf.length, from + n))];
  let corrupt = 0;
  let i = 0;
  while (i < buf.length) {
    // Sommige ELRS/firmware-varianten sturen een extra 0xC8-sync vóór het
    // eigenlijke frame (bv. "C8 EA 0D 3A ..."). Een echt frame met adres 0xC8
    // kan nooit een lengte 0xEA/0xEC/0xEE hebben (max 62), dus zo'n byte is
    // veilig als extra sync te behandelen.
    if (buf[i] === CRSF_ADDR && i + 1 < buf.length && isCrsfSyncAddress(buf[i + 1]!)) {
      i++;
      continue;
    }
    if (!isCrsfSyncAddress(buf[i]!)) {
      i++;
      continue;
    }
    if (i + 2 > buf.length) break;
    const len = buf[i + 1]!;
    if (len < 2 || len > 62) {
      corrupt++;
      reject({ reason: "bad-len", len, bytes: snippet(i, 8) });
      i++;
      continue;
    }
    if (i + 2 + len > buf.length) break; // onvolledig
    const type = buf[i + 2]!;
    const payload = buf.slice(i + 3, i + 2 + len - 1);
    const wantCrc = buf[i + 2 + len - 1]!;
    let crc = 0;
    crc = crc8DvbS2(crc, type);
    for (const b of payload) crc = crc8DvbS2(crc, b);
    if (crc !== wantCrc) {
      corrupt++;
      reject({ reason: "bad-crc", type, len, bytes: snippet(i, Math.min(16, 2 + len)) });
      i++;
      continue;
    }
    frames.push({ type, payload });
    i += 2 + len;
  }
  return { frames, rest: buf.slice(i), corrupt, bad };
}

export interface LinkStats {
  uplinkRssiDbm: number;
  uplinkLq: number;
  downlinkRssiDbm: number;
  downlinkLq: number;
}

/** CRSF link-statistics (0x14), 10B payload. dBm = -value. */
export function decodeLinkStats(payload: Uint8Array): LinkStats | null {
  if (payload.length < 10) return null;
  // ELRS stuurt RSSI als signed int8 (0xD3 = -45 dBm); de TBS-spec noemt
  // een magnitude (0x2D = -45 dBm). Beide komen voor, dus interpreteer
  // hoge bytes als signed en lage bytes als magnitude.
  const rssiDbm = (b: number): number => (b >= 0x80 ? b - 0x100 : -b);
  return {
    uplinkRssiDbm: rssiDbm(payload[0]!),
    uplinkLq: payload[2]!,
    downlinkRssiDbm: rssiDbm(payload[7]!),
    downlinkLq: payload[8]!,
  };
}

// ---------------------------------------------------------------- postcard (spiegelt tools/postcard_codec.py)
export const enum PidAxis {
  Roll = 0,
  Pitch = 1,
  Yaw = 2,
}

export type FromPc =
  | { kind: "arm" }
  | { kind: "disarm" }
  | { kind: "setPid"; axis: number; kp: number; ki: number; kd: number }
  | { kind: "setFilter"; gyroCutoff: number; dtermCutoffLpf1: number; dtermCutoffLpf2: number };

export type ToPc =
  | { kind: "attitude"; roll: number; pitch: number; yaw: number }
  | { kind: "systemState"; state: number; armBlocks: number; errors: number }
  | { kind: "ack" }
  | { kind: "log"; message: string };

export const SYSTEM_STATE_NAMES: Record<number, string> = {
  0: "INIT",
  1: "DISARMED",
  2: "ARMED",
  3: "FAILSAFE",
  4: "CALIBRATING",
};

export function encodeVarint(v: number): Uint8Array {
  if (!Number.isInteger(v) || v < 0) throw new Error(`varint needs uint, got ${v}`);
  const out: number[] = [];
  while (true) {
    let b = v & 0x7f;
    v >>>= 7;
    // getrouw aan LEB128 voor >32-bit via deling als nodig
    if (v !== 0) out.push(b | 0x80);
    else {
      out.push(b);
      break;
    }
  }
  return new Uint8Array(out);
}

export function decodeVarint(buf: Uint8Array, offset: number): { value: number; next: number } | null {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i]!;
    i++;
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return { value: result, next: i };
    shift += 7;
    if (shift > 49) throw new Error("varint too large");
  }
  return null; // incompleet
}

export function encodeFromPc(cmd: FromPc): Uint8Array {
  const parts: Uint8Array[] = [];
  const push = (u: Uint8Array) => parts.push(u);
  if (cmd.kind === "arm") push(encodeVarint(0));
  else if (cmd.kind === "disarm") push(encodeVarint(1));
  else if (cmd.kind === "setPid") {
    if (!Number.isInteger(cmd.axis) || cmd.axis < 0 || cmd.axis > 2) {
      throw new Error(`axis must be 0..2, got ${cmd.axis}`);
    }
    push(encodeVarint(2));
    const b = new Uint8Array(13);
    b[0] = cmd.axis;
    new DataView(b.buffer).setFloat32(1, cmd.kp, true);
    new DataView(b.buffer).setFloat32(5, cmd.ki, true);
    new DataView(b.buffer).setFloat32(9, cmd.kd, true);
    push(b);
  } else {
    push(encodeVarint(3));
    // Draadvolgorde: gyro, dterm-lpf1, dterm-lpf2 (3× f32 LE = 13B totaal).
    const b = new Uint8Array(12);
    new DataView(b.buffer).setFloat32(0, cmd.gyroCutoff, true);
    new DataView(b.buffer).setFloat32(4, cmd.dtermCutoffLpf1, true);
    new DataView(b.buffer).setFloat32(8, cmd.dtermCutoffLpf2, true);
    push(b);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface ToPcMessage {
  msg: ToPc;
  /** Exacte ruwe bytes van dit bericht (voor diagnose). */
  raw: Uint8Array;
}

export interface PostcardParseResult {
  messages: ToPcMessage[];
  rest: Uint8Array;
}

/** Streaming decoder voor ToPc over CDC (1 USB-pakket = 1 bericht, maar mag concateneren). */
export function parseToPcStream(buf: Uint8Array): PostcardParseResult {
  const messages: ToPcMessage[] = [];
  const emit = (msg: ToPc, from: number, to: number) =>
    messages.push({ msg, raw: buf.slice(from, to) });
  let offset = 0;
  while (offset < buf.length) {
    const from = offset;
    let disc: { value: number; next: number } | null;
    try {
      disc = decodeVarint(buf, offset);
    } catch {
      break;
    }
    if (!disc) break;
    const { value: variant, next } = disc;
    if (variant === 0) {
      if (buf.length - next < 12) break;
      const dv = new DataView(buf.buffer, buf.byteOffset + next, 12);
      emit(
        {
          kind: "attitude",
          roll: dv.getFloat32(0, true),
          pitch: dv.getFloat32(4, true),
          yaw: dv.getFloat32(8, true),
        },
        from,
        next + 12,
      );
      offset = next + 12;
    } else if (variant === 1) {
      if (buf.length - next < 1) break;
      const state = buf[next]!;
      const a = decodeVarint(buf, next + 1);
      if (!a) break;
      const e = decodeVarint(buf, a.next);
      if (!e) break;
      emit({ kind: "systemState", state, armBlocks: a.value, errors: e.value }, from, e.next);
      offset = e.next;
    } else if (variant === 2) {
      emit({ kind: "ack" }, from, next);
      offset = next;
    } else if (variant === 3) {
      const l = decodeVarint(buf, next);
      if (!l) break;
      if (buf.length - l.next < l.value) break;
      const bytes = buf.slice(l.next, l.next + l.value);
      emit({ kind: "log", message: new TextDecoder().decode(bytes) }, from, l.next + l.value);
      offset = l.next + l.value;
    } else {
      throw new Error(`unknown ToPc discriminant: ${variant}`);
    }
  }
  return { messages, rest: buf.slice(offset) };
}

// ---------------------------------------------------------------- ELRS-tuning over 0x7A/0x7B (contract met rust_fc/src/receiver/crsf.rs + tasks/tx.rs)
// FC zendt antwoorden als CRSF-frame type 0x7B. Als extended frame:
//   [dest][origin][sub-id (u16 LE)][data...]
// Oudere FC-builds stuurden de sub-id direct na het type (zonder dest/origin);
// decodeTelemetry7B accepteert tijdelijk beide vormen.
// Ze komen via de ELRS-TX-module (USB) binnen, dus de backend leest ze op de TX-poort.
//   0x7F03 ping-echo: sub-id + de ORIGINELE bytes (≤8B, seq+timestamp+random) ongewijzigd terug.
//   0x7F04 TunAck:    sub-id + postcard-TunAck (spiegelt rust_fc/src/sync.rs).
export const CRSF_TYPE_TELEMETRY = 0x7b;
export const TUN_SUB_PING = 0x7f03;
export const TUN_SUB_TUN_ACK = 0x7f04;
/** Postcard-commando (SetPid/SetFilter) in een 0x7A-frame; spiegelt TuningCmd::Postcard. */
export const TUN_SUB_POSTCARD = 0x7f00;

export type TunAck =
  | { kind: "pid"; axis: number; kp: number; ki: number; kd: number; ok: boolean }
  | { kind: "filter"; gyro: number; lpf1: number; lpf2: number; ok: boolean };

/** Decodeer postcard-TunAck: varint-discriminant (0=Pid, 1=Filter) + velden in declaratievolgorde. */
export function decodeTunAckPayload(data: Uint8Array): TunAck {
  const disc = decodeVarint(data, 0);
  if (!disc) throw new Error("TunAck truncated (discriminant)");
  const dv = new DataView(data.buffer, data.byteOffset + disc.next);
  const rest = (n: number) => {
    if (data.length - disc.next < n) throw new Error(`TunAck truncated (need ${n}B)`);
  };
  const f32 = (at: number) => dv.getFloat32(at, true);
  if (disc.value === 0) {
    rest(14);
    return {
      kind: "pid",
      axis: dv.getUint8(0),
      kp: f32(1),
      ki: f32(5),
      kd: f32(9),
      ok: dv.getUint8(13) !== 0,
    };
  } else if (disc.value === 1) {
    rest(13);
    return {
      kind: "filter",
      gyro: f32(0),
      lpf1: f32(4),
      lpf2: f32(8),
      ok: dv.getUint8(12) !== 0,
    };
  }
  throw new Error(`unknown TunAck discriminant: ${disc.value}`);
}

export type Telemetry7B =
  | { kind: "ping"; bytes: Uint8Array }
  | { kind: "tunack"; ack: TunAck }
  | { kind: "unknown"; sub: number };

/** Splits een 0x7B-payload op sub-id. Gooit bij TunAck-decodefouten (corrupte inhoud).
 *  0x7B is een extended frame: [dest][origin][sub-id lo][sub-id hi][data...].
 *  Oudere FC-builds stuurden nog [sub-id...] zonder dest/origin; die blijven we
 *  tijdens de overgang ook snappen. */
export function decodeTelemetry7B(payload: Uint8Array): Telemetry7B | null {
  const extended =
    payload.length >= 4 && isCrsfDeviceAddress(payload[0]!) && isCrsfDeviceAddress(payload[1]!);
  const body = extended ? payload.subarray(2) : payload;
  if (body.length < 2) return null;
  const sub = body[0]! | (body[1]! << 8);
  if (sub === TUN_SUB_PING) return { kind: "ping", bytes: body.slice(2) };
  if (sub === TUN_SUB_TUN_ACK) return { kind: "tunack", ack: decodeTunAckPayload(body.slice(2)) };
  return { kind: "unknown", sub };
}

// ---------------------------------------------------------------- ELRS-tuning heartbeat (dashboard -> FC, via TX-module)
// Ping-verzoek als CRSF extended frame (MSP_REQ-conventie, vgl. Betaflight-tx-lua:
// dest=0xC8 wordt door de ELRS-TX-module naar de RX/FC doorgezet, orig=0xEA is de radio-kant):
//   [0xC8][len][0x7A][0xC8][0xEA][0x03][0x7F][payload 8B][crc8-DVB-S2 over type..payload]
// payload: seq u16LE + dashboard-tijd ms u32LE + random u16 (8B totaal, FC echoot alles terug).
export const CRSF_TYPE_MSP_REQ = 0x7a;
export const CRSF_ADDR_FC = 0xc8;
// CRSF_ADDR_RADIO staat bovenaan gedefinieerd (0xEA).

/** Wrap een extended-frame body (dest+origin+sub-id+data) in een 0x7A-frame. */
function wrapCrsfExtendedRequest(body: Uint8Array): Uint8Array {
  const frame = new Uint8Array(3 + body.length + 1);
  frame[0] = CRSF_ADDR_FC; // sync-byte
  frame[1] = 1 + body.length + 1; // type + body + crc
  frame[2] = CRSF_TYPE_MSP_REQ;
  frame.set(body, 3);
  let crc = 0;
  for (let i = 2; i < 3 + body.length; i++) crc = crc8DvbS2(crc, frame[i]!);
  frame[3 + body.length] = crc;
  return frame;
}

/** Postcard-encoding van rust_fc/src/receiver/crsf.rs::TuneMsg (variant-index + velden). */
function encodeTuneMsg(cmd: FromPc): Uint8Array {
  if (cmd.kind === "setPid") {
    if (!Number.isInteger(cmd.axis) || cmd.axis < 0 || cmd.axis > 2) {
      throw new Error(`axis must be 0..2, got ${cmd.axis}`);
    }
    const b = new Uint8Array(14);
    b[0] = 0; // TuneMsg::SetPid
    b[1] = cmd.axis;
    const dv = new DataView(b.buffer);
    dv.setFloat32(2, cmd.kp, true);
    dv.setFloat32(6, cmd.ki, true);
    dv.setFloat32(10, cmd.kd, true);
    return b;
  }
  if (cmd.kind === "setFilter") {
    const b = new Uint8Array(13);
    b[0] = 1; // TuneMsg::SetFilter
    const dv = new DataView(b.buffer);
    dv.setFloat32(1, cmd.gyroCutoff, true);
    dv.setFloat32(5, cmd.dtermCutoffLpf1, true);
    dv.setFloat32(9, cmd.dtermCutoffLpf2, true);
    return b;
  }
  throw new Error(`encodeTuneMsg: alleen setPid/setFilter, kreeg ${cmd.kind}`);
}

/** Live tuning via ELRS: SetPid/SetFilter als 0x7A extended frame (TuningCmd::Postcard). */
export function encodeCrsfTune(cmd: FromPc): Uint8Array {
  const data = encodeTuneMsg(cmd);
  const body = new Uint8Array(4 + data.length);
  body[0] = CRSF_ADDR_FC; // dest
  body[1] = CRSF_ADDR_RADIO; // origin
  body[2] = TUN_SUB_POSTCARD & 0xff;
  body[3] = (TUN_SUB_POSTCARD >> 8) & 0xff;
  body.set(data, 4);
  return wrapCrsfExtendedRequest(body);
}

export function encodeTuningPing(seq: number, nowMs: number, rand: number): Uint8Array {
  const payload = new Uint8Array(8);
  const dv = new DataView(payload.buffer);
  dv.setUint16(0, seq & 0xffff, true);
  dv.setUint32(2, nowMs >>> 0, true);
  dv.setUint16(6, rand & 0xffff, true);
  const body = new Uint8Array([
    CRSF_ADDR_FC,
    CRSF_ADDR_RADIO,
    TUN_SUB_PING & 0xff,
    (TUN_SUB_PING >> 8) & 0xff,
    ...payload,
  ]);
  return wrapCrsfExtendedRequest(body);
}

export interface PingEcho {
  seq: number;
  sentMs: number;
  rand: number;
}

/** Lees seq/tijd/random uit een 0x7F03-echo (null bij <8B). */
export function parsePingPayload(bytes: Uint8Array | number[]): PingEcho | null {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 8) return null;
  const dv = new DataView(b.buffer, b.byteOffset, 8);
  return { seq: dv.getUint16(0, true), sentMs: dv.getUint32(2, true), rand: dv.getUint16(6, true) };
}

// ---------------------------------------------------------------- websocket-protocol (JSON)
export type PcToBackend =
  | {
      t: "input";
      roll: number;
      pitch: number;
      throttle: number;
      yaw: number;
      modeRate: boolean;
      armed: boolean;
    }
  | { t: "fc"; cmd: FromPc }
  | { t: "tune"; cmd: FromPc }
  | { t: "reconnect"; port: "tx" | "fc" }
  | { t: "setTxBaud"; baud: number };

export type BackendToPc =
  | {
      t: "status";
      tx: PortState;
      fc: PortState;
      bridgeHz: number;
      inputAgeMs: number | null;
      corruptFrames: number;
      fcSupported: boolean;
      txUpBytes: number;
      txDownBytes: number;
      pingRttMs: number | null;
    }
  | { t: "channels"; ch: number[]; hz: number }
  | { t: "link"; stats: LinkStats }
  | { t: "attitude"; roll: number; pitch: number; yaw: number }
  | { t: "system"; state: number; stateName: string; armBlocks: number; errors: number }
  | { t: "ack" }
  | { t: "tunack"; ack: TunAck }
  | { t: "ping"; seq: number; bytes: number[]; rttMs: number | null }
  | { t: "rx"; sight: RxSight }
  | { t: "log"; level: LogLevel; message: string }
  | { t: "banner"; port: "tx" | "fc" | "hid"; message: string };

export interface PortState {
  name: string;
  baud: number;
  open: boolean;
  error?: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

// ---------------------------------------------------------------- TX-baudrates (UI-keuze + backend)
// Standaard 921600 (ELRS-TX-USB), alternatief 420000 — of een eigen waarde.
export const TX_BAUD_PRESETS = [921600, 420000] as const;
export const TX_BAUD_MIN = 1200;
export const TX_BAUD_MAX = 2000000;

export function isValidTxBaud(b: unknown): b is number {
  return Number.isInteger(b) && (b as number) >= TX_BAUD_MIN && (b as number) <= TX_BAUD_MAX;
}

// ---------------------------------------------------------------- RX-inspector: alles wat terugkomt, ook fouten
/** Eén waargenomen bericht op een seriële poort — geldig én afgekeurd. */
export type RxSightKind =
  | "link"
  | "radio"
  | "ping"
  | "tunack"
  | "fc"
  | "other"
  | "error";

export interface RxSight {
  port: "tx" | "fc";
  /** Uniek, oplopend id — stabiele React-key en sortering. */
  id: number;
  /** Backend-tijd (epoch ms) van ontvangst. */
  at: number;
  /** false = afgekeurd/corrupt (CRC-fout, onbekende discriminant, te kort, …). */
  ok: boolean;
  /** Categorie voor het filter in de RX-inspector. */
  kind: RxSightKind;
  /** Korte samenvatting, bv. "0x7B sub 0x7F03 ping-echo" of "CRC-fout". */
  label: string;
  /** Ruwe bytes (gecapt, max 48B) — leeg als niet beschikbaar. */
  bytes: number[];
  /** Decodedetails of fouttekst. */
  note?: string;
}

export * from "./xbox.js";
