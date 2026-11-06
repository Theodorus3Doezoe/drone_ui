// Pure Xbox-/stick-helpers, zonder DOM-afhankelijkheid (testbaar in Node).
// Echte Xbox-pads spreken over USB XInput (geen HID); browsers normaliseren dat
// via de Gamepad-API ("standard"-mapping). De parser hieronder dekt het
// XInput-rapport zoals o.a. de Linux-xpad-driver dat aanbiedt, plus een
// generieke HID-fallback voor echte USB-HID-joysticks (bv. Boxer).

export const XBOX_VID = 0x045e;
export const XBOX_PIDS = new Set([
  0x028e, // 360 wired
  0x028f, // 360 wireless (receiver)
  0x02d1, // One
  0x02dd, // One S (USB+BT)
  0x02e0, // One X
  0x02ea, // One S BT
  0x0b12, // Series X|S
  0x0b13, // Series X|S (2e rev)
]);

// XInput-buttonmasker (offset 2, u16 LE in 360-rapport)
export const enum XInputButton {
  DPadUp = 0x0001,
  DPadDown = 0x0002,
  DPadLeft = 0x0004,
  DPadRight = 0x0008,
  Start = 0x0010,
  Back = 0x0020,
  LeftThumb = 0x0040,
  RightThumb = 0x0080,
  LeftShoulder = 0x0100,
  RightShoulder = 0x0200,
  A = 0x1000,
  B = 0x2000,
  X = 0x4000,
  Y = 0x8000,
}

export interface XInputState {
  /** -1..1, Y omhoog positief (XInput-conventie). */
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  /** 0..1 */
  lt: number;
  rt: number;
  buttons: number;
}

/** Deadband met rescale + expo-kromme. v in -1..1. */
export function applyCurve(v: number, expo = 0, deadband = 0.04): number {
  if (!Number.isFinite(v)) return 0;
  const clamped = Math.min(1, Math.max(-1, v));
  const a = Math.abs(clamped);
  if (a < deadband) return 0;
  const rescaled = Math.sign(clamped) * ((a - deadband) / (1 - deadband));
  const e = Math.min(0.9, Math.max(0, expo));
  return (1 - e) * rescaled + e * rescaled * rescaled * rescaled;
}

function s16le(buf: Uint8Array, off: number): number {
  const raw = buf[off]! | (buf[off + 1]! << 8);
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

/**
 * Parse een XInput-rapport (Xbox 360-layout, 20B: 00 14 <btn lo><btn hi>
 * <LT><RT> <LX><LY><RX><RY als s16 LE>). Grotere rapporten die met
 * 00 14 beginnen worden ook geaccepteerd. Retourneert null bij mismatch.
 */
export function parseXInputReport(buf: Uint8Array): XInputState | null {
  if (buf.length < 14) return null;
  if (buf[0] !== 0x00 || buf[1] !== 0x14) return null;
  const buttons = buf[2]! | (buf[3]! << 8);
  const norm = (raw: number) => Math.min(1, Math.max(-1, raw / (raw < 0 ? 32768 : 32767)));
  return {
    lx: norm(s16le(buf, 6)),
    ly: norm(s16le(buf, 8)),
    rx: norm(s16le(buf, 10)),
    ry: norm(s16le(buf, 12)),
    lt: buf[4]! / 255,
    rt: buf[5]! / 255,
    buttons,
  };
}

export interface GenericHidConfig {
  /** Byte-offsets (na eventuele report-ID) van assen X,Y,Rx,Ry. */
  axes: [number, number, number, number];
  /** Middenwaarde voor 8-bit assen. */
  center: number;
  /** Halve uitslag (255 -> 127.5). */
  halfRange: number;
}

export const DEFAULT_GENERIC_HID: GenericHidConfig = {
  axes: [1, 2, 3, 4], // [0] is meestal de report-ID
  center: 128,
  halfRange: 127,
};

/** Generieke 8-bit HID-assen (bv. Boxer in joystick-modus) -> -1..1. */
export function parseGenericHid(buf: Uint8Array, cfg: GenericHidConfig = DEFAULT_GENERIC_HID): number[] | null {
  const max = Math.max(...cfg.axes);
  if (buf.length <= max) return null;
  return cfg.axes.map((off) => Math.min(1, Math.max(-1, (buf[off]! - cfg.center) / cfg.halfRange)));
}
