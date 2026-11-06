// Headless controller-input via node-hid (optioneel).
// Let op: echte Xbox-pads zijn over USB meestal géén HID maar XInput — gebruik
// dan de frontend (Gamepad-API). Deze module dekt: (1) XInput-rapporten zoals de
// Linux-xpad-driver die aanbiedt, (2) generieke 8-bit HID-joysticks (Boxer e.d.).
import {
  DEFAULT_GENERIC_HID,
  XBOX_PIDS,
  XBOX_VID,
  applyCurve,
  parseGenericHid,
  parseXInputReport,
  type GenericHidConfig,
} from "@ground-station/shared";
import type { Bridge } from "./bridge.js";

export interface HidOptions {
  path?: string;
  auto: boolean;
  expo: number;
  deadband: number;
  throttlePreset: "mode2" | "triggers";
  generic: GenericHidConfig;
}

type HidDevice = {
  on(event: "data", cb: (data: Buffer) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  close(): void;
};

type HidModule = {
  HID: new (path: string) => HidDevice;
  devices(): { path?: string; vendorId?: number; productId?: number; usagePage?: number; usage?: number }[];
};

// Toggle-status voor het headless XInput-pad: stijgende flank flipt,
// dus arm/mode zijn ook hier toggles i.p.v. hold (zelfde als frontend).

async function loadHid(): Promise<HidModule | null> {
  try {
    return (await import("node-hid").catch(() => null)) as HidModule | null;
  } catch {
    return null;
  }
}

function pickDevice(
  HID: HidModule,
  explicitPath?: string,
): { path: string; productId?: number } | null {
  const all = HID.devices().filter((d) => d.path);
  if (explicitPath) return { path: explicitPath };
  // 1. Xbox VID+PID (alleen als het OS hem als HID aanbiedt)
  const xbox = all.find((d) => d.vendorId === XBOX_VID && d.productId !== undefined && XBOX_PIDS.has(d.productId));
  if (xbox?.path) return { path: xbox.path, productId: xbox.productId };
  // 2. generieke joystick/gamepad-usages (0x01:0x04 joystick, 0x01:0x05 gamepad)
  const joy = all.find(
    (d) => d.usagePage === 0x01 && (d.usage === 0x04 || d.usage === 0x05) && d.path,
  );
  if (joy?.path) return { path: joy.path, productId: joy.productId };
  return null;
}

/**
 * XInput-state -> piloot-input. Zelfde conventies als frontend/src/xbox.ts:
 * XInput-Y omhoog positief, dus throttle = (ly+1)/2 in mode2.
 */
export function xinputToPilot(
  s: { lx: number; ly: number; rx: number; ry: number; lt: number; rt: number; buttons: number },
  throttlePreset: "mode2" | "triggers",
  expo: number,
  deadband: number,
): { roll: number; pitch: number; throttle: number; yaw: number; modeRate: boolean; armed: boolean } {
  const dz = (v: number) => applyCurve(v, expo, deadband);
  const LB = 0x0100;
  const RB = 0x0200;
  if (throttlePreset === "mode2") {
    return {
      yaw: dz(s.lx),
      throttle: Math.min(1, Math.max(0, (dz(s.ly) + 1) / 2)),
      roll: dz(s.rx),
      pitch: dz(s.ry),
      modeRate: (s.buttons & LB) !== 0,
      armed: (s.buttons & RB) !== 0,
    };
  }
  return {
    roll: dz(s.lx),
    pitch: dz(s.ly),
    yaw: dz(s.rx),
    throttle: Math.min(1, Math.max(0, (s.rt - s.lt + 1) / 2)),
    modeRate: (s.buttons & LB) !== 0,
    armed: (s.buttons & RB) !== 0,
  };
}

let hidPrevArmBtn = false;
let hidPrevModeBtn = false;
let hidLatchedArm = false;
let hidLatchedMode = false;

/** Start HID-polling; stil als node-hid ontbreekt of geen device gevonden. */
export async function startHid(bridge: Bridge, opts: HidOptions): Promise<void> {
  if (!opts.auto && !opts.path) return;
  const HID = await loadHid();
  if (!HID) {
    console.warn("node-hid niet beschikbaar, HID-input uit (gebruik frontend voor Xbox-pad)");
    return;
  }
  const dev = pickDevice(HID, opts.path);
  if (!dev) {
    console.warn("geen HID-controller gevonden (Xbox-pads zijn meestal XInput, geen HID — gebruik de frontend)");
    return;
  }
  try {
    const hid = new HID.HID(dev.path);
    console.log(`HID-controller open: ${dev.path} (pid ${dev.productId?.toString(16) ?? "?"})`);
    hid.on("data", (data: Buffer) => {
      const buf = new Uint8Array(data);
      const xi = parseXInputReport(buf);
      if (xi) {
        const p = xinputToPilot(xi, opts.throttlePreset, opts.expo, opts.deadband);
        if (p.armed && !hidPrevArmBtn) hidLatchedArm = !hidLatchedArm;
        hidPrevArmBtn = p.armed;
        if (p.modeRate && !hidPrevModeBtn) hidLatchedMode = !hidLatchedMode;
        hidPrevModeBtn = p.modeRate;
        bridge.setInput(p.roll, p.pitch, p.throttle, p.yaw, hidLatchedMode, hidLatchedArm);
        return;
      }
      const axes = parseGenericHid(buf, opts.generic ?? DEFAULT_GENERIC_HID);
      if (axes && axes.length >= 4) {
        const dz = (v: number) => applyCurve(v, opts.expo, opts.deadband);
        // Generiek: X=roll, Y=pitch, Rx=yaw, Ry=throttle (valt terug op UI-switches).
        bridge.setInput(dz(axes[0]!), dz(-axes[1]!), (axes[3]! + 1) / 2, dz(axes[2]!), false, false);
        return;
      }
      // Onherkenbaar rapport: negeren (geen failsafe triggeren op 1 frame).
    });
    hid.on("error", (e: Error) => bridge.setHidLost(e.message));
  } catch (e) {
    bridge.setHidLost(e instanceof Error ? e.message : String(e));
  }
}
