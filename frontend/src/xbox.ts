// Xbox-pad via de Gamepad-API ("standard"-mapping, cross-browser/cross-OS).
// Standaard-indices: assen LX=0 LY=1 RX=2 RY=3; knoppen A=0 B=1 X=2 Y=3
// LB=4 RB=5 LT=6 RT=6(nieuwer: 6/7 analoog) Back=8 Start=9.
import { applyCurve } from "@ground-station/shared";

export type ThrottlePreset = "mode2" | "triggers";

export interface XboxConfig {
  preset: ThrottlePreset;
  expo: number;
  deadband: number;
  /** Index van de arm-knop (undefined = auto per klasse, -1 = uit). */
  armButton?: number;
  /** Index van de mode-knop (undefined = auto per klasse, -1 = uit). */
  modeButton?: number;
  /** Index van de arm-AS (RC-klasse, undefined = auto, -1 = uit). */
  armAxis?: number;
  /** Index van de mode-AS (RC-klasse, undefined = auto, -1 = uit). */
  modeAxis?: number;
}

export const DEFAULT_XBOX_CONFIG: XboxConfig = { preset: "mode2", expo: 0.2, deadband: 0.05 };

export type PadClass = "xbox" | "rc" | "generic";

/** Classificeer aan de hand van de Gamepad-id: Xbox/XInput vs RC-remote (EdgeTX) vs overig. */
export function classifyPad(p: { id: string; mapping: string }): PadClass {
  const id = (p.id ?? "").toLowerCase();
  if (
    /radiomaster|frsky|jumper|boxer|taranis|horus|tx1[26]|tx12|zorro|pocket|t-lite|tlite|edgetx|opentx|betafpv/.test(
      id,
    )
  )
    return "rc";
  if (/xbox|xinput|045e/.test(id) || p.mapping === "standard") return "xbox";
  return "generic";
}

export interface ButtonMap {
  arm: number;
  mode: number;
  start: number;
  back: number;
  /** -1 = niet gemapt (Xbox gebruikt knoppen, RC assen). */
  armAxis: number;
  modeAxis: number;
}

/** -1 = niet gemapt. */
export const XBOX_BUTTONS: ButtonMap = { arm: 5, mode: 4, start: 9, back: 8, armAxis: -1, modeAxis: -1 };
/** RC-klasse (EdgeTX-model van Sven): CH5 = mode op as 4, CH9 = arm op as 8. */
export const RC_BUTTONS: ButtonMap = { arm: -1, mode: -1, start: -1, back: -1, armAxis: 8, modeAxis: 4 };

export interface PilotAxes {
  roll: number;
  pitch: number;
  throttle: number; // 0..1
  yaw: number;
  modeRate: boolean;
  armedHold: boolean;
  startPressed: boolean;
  backPressed: boolean;
}

/**
 * Map een aangesloten controller op piloot-assen.
 * - xbox/generic: Xbox-conventies (mode2-preset of triggers-preset).
 * - rc (EdgeTX USB-joystick): assen 0..3 = AIL/ELE/THR/RUD, throttle over het
 *   volle bereik zonder center-deadband (ratel-stick blijft staan).
 * Knoppen (arm/mode/start/back) komen uit `map`; -1 = niet gemapt.
 * Assen (armAxis/modeAxis) zijn houd-niveaus (RC-schakelaars): >0 = aan.
 * Let op pitch-teken: gaat ELE omhoog de verkeerde kant op, dan is één minteken hier de fix.
 */
export function gamepadToPilot(pad: Gamepad, cfg: XboxConfig, map: ButtonMap, cls: PadClass): PilotAxes {
  const dz = (v: number) => applyCurve(v, cfg.expo, cfg.deadband);
  const btn = (i: number) => (i >= 0 ? (pad.buttons[i]?.pressed ?? false) : false);
  const val = (i: number) => pad.buttons[i]?.value ?? 0;
  const ax = (i: number) => pad.axes[i] ?? 0;

  let roll: number;
  let pitch: number;
  let throttle: number;
  let yaw: number;
  let modeRate: boolean;
  let armedHold: boolean;
  if (cls === "rc") {
    roll = dz(ax(0));
    pitch = dz(-ax(1));
    throttle = Math.min(1, Math.max(0, (ax(2) + 1) / 2));
    yaw = dz(ax(3));
    // Houd-schakelaars: direct niveau, géén flank (flank-logica zit alleen op knoppen).
    // Bestaat de as niet (browser meldt minder assen dan CH telt), val terug op knop.
    modeRate =
      map.modeAxis >= 0 && map.modeAxis < pad.axes.length
        ? ax(map.modeAxis) > 0
        : btn(map.mode);
    armedHold =
      map.armAxis >= 0 && map.armAxis < pad.axes.length
        ? ax(map.armAxis) > 0
        : btn(map.arm);
  } else if (cfg.preset === "mode2") {
    yaw = dz(ax(0));
    throttle = Math.min(1, Math.max(0, (-dz(ax(1)) + 1) / 2));
    roll = dz(ax(2));
    pitch = dz(-ax(3));
    modeRate = btn(map.mode);
    armedHold = btn(map.arm);
  } else {
    roll = dz(ax(0));
    pitch = dz(-ax(1));
    yaw = dz(ax(2));
    throttle = Math.min(1, Math.max(0, (val(7) - val(6) + 1) / 2));
    modeRate = btn(map.mode);
    armedHold = btn(map.arm);
  }
  return {
    roll,
    pitch,
    throttle,
    yaw,
    modeRate,
    armedHold,
    startPressed: btn(map.start),
    backPressed: btn(map.back),
  };
}

/** Vind de eerste aangesloten gamepad (bij voorkeur standard-mapping). */
export function findPad(): Gamepad | null {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return null;
  const pads = [...navigator.getGamepads()].filter((p): p is Gamepad => !!p?.connected);
  return pads.find((p) => p.mapping === "standard") ?? pads[0] ?? null;
}

export const XBOX_LEGEND: [string, string][] = [
  ["Linker stick", "mode2: yaw + throttle / triggers: roll + pitch"],
  ["Rechter stick", "mode2: roll + pitch / triggers: yaw (X)"],
  ["RT / LT", "triggers-preset: throttle (verschil RT−LT)"],
  ["RB", "arm TOGGLE (indrukken = om)"],
  ["LB", "mode TOGGLE (Angle ↔ Rate)"],
  ["Start", "arm AAN (absoluut)"],
  ["Back", "arm UIT (absoluut, paniekknop)"],
];

export const RC_LEGEND: [string, string][] = [
  ["Linker stick", "yaw + throttle (ratel: blijft staan waar je hem laat)"],
  ["Rechter stick", "roll + pitch"],
  ["CH5-schakelaar", "mode: omhoog (-100) = Angle, omlaag (+100) = Rate"],
  ["CH9-schakelaar", "arm: ingedrukt (+100) = ARMED (houd-stand, geen toggle-flank)"],
  ["Kanaalkeuze", "afwijkend model? Kies hierboven een andere arm/mode-as"],
];
