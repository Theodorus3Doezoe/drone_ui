// Gedeelde contracten ground-station <-> FC / ELRS.
// Kanaallayout is een contract met rust_fc/src/receiver/crsf.rs — exact aanhouden.

// ---------------------------------------------------------------- CRSF
export const CRSF_MIN = 172;
export const CRSF_MID = 992;
export const CRSF_MAX = 1811;
export const CRSF_SPAN = CRSF_MAX - CRSF_MID; // 819
export const CRSF_ADDR = 0xc8;
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
}

/** Incrementele parser: valideer len + CRC, drop corrupte frames met teller. */
export function parseCrsfStream(buf: Uint8Array): CrsfParseResult {
  const frames: CrsfFrame[] = [];
  let corrupt = 0;
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== CRSF_ADDR) {
      i++;
      continue;
    }
    if (i + 2 > buf.length) break;
    const len = buf[i + 1]!;
    if (len < 2 || len > 62) {
      i++;
      corrupt++;
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
      i++;
      continue;
    }
    frames.push({ type, payload });
    i += 2 + len;
  }
  return { frames, rest: buf.slice(i), corrupt };
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
  return {
    uplinkRssiDbm: -payload[0]!,
    uplinkLq: payload[2]!,
    downlinkRssiDbm: -payload[7]!,
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

export interface PostcardParseResult {
  messages: ToPc[];
  rest: Uint8Array;
}

/** Streaming decoder voor ToPc over CDC (1 USB-pakket = 1 bericht, maar mag concateneren). */
export function parseToPcStream(buf: Uint8Array): PostcardParseResult {
  const messages: ToPc[] = [];
  let offset = 0;
  while (offset < buf.length) {
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
      messages.push({
        kind: "attitude",
        roll: dv.getFloat32(0, true),
        pitch: dv.getFloat32(4, true),
        yaw: dv.getFloat32(8, true),
      });
      offset = next + 12;
    } else if (variant === 1) {
      if (buf.length - next < 1) break;
      const state = buf[next]!;
      const a = decodeVarint(buf, next + 1);
      if (!a) break;
      const e = decodeVarint(buf, a.next);
      if (!e) break;
      messages.push({ kind: "systemState", state, armBlocks: a.value, errors: e.value });
      offset = e.next;
    } else if (variant === 2) {
      messages.push({ kind: "ack" });
      offset = next;
    } else if (variant === 3) {
      const l = decodeVarint(buf, next);
      if (!l) break;
      if (buf.length - l.next < l.value) break;
      const bytes = buf.slice(l.next, l.next + l.value);
      messages.push({ kind: "log", message: new TextDecoder().decode(bytes) });
      offset = l.next + l.value;
    } else {
      throw new Error(`unknown ToPc discriminant: ${variant}`);
    }
  }
  return { messages, rest: buf.slice(offset) };
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
  | { t: "reconnect"; port: "tx" | "fc" };

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
    }
  | { t: "channels"; ch: number[]; hz: number }
  | { t: "link"; stats: LinkStats }
  | { t: "attitude"; roll: number; pitch: number; yaw: number }
  | { t: "system"; state: number; stateName: string; armBlocks: number; errors: number }
  | { t: "ack" }
  | { t: "log"; level: LogLevel; message: string }
  | { t: "banner"; port: "tx" | "fc" | "hid"; message: string };

export interface PortState {
  name: string;
  baud: number;
  open: boolean;
  error?: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export * from "./xbox.js";
