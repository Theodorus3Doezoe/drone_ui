import { useEffect, useRef, useState } from "react";
import type { BackendToPc, FromPc, LinkStats, LogLevel, PortState, RxSight, TunAck } from "@ground-station/shared";
import {
  CH_ARM,
  CH_MODE,
  CH_PITCH,
  CH_ROLL,
  CH_THROTTLE,
  CH_YAW,
  CRSF_MID,
  stickToCrsf,
  switchToCrsf,
  throttleToCrsf,
} from "@ground-station/shared";
import { DEFAULT_XBOX_CONFIG, RC_BUTTONS, XBOX_BUTTONS, classifyPad, findPad, gamepadToPilot, type ButtonMap, type PadClass, type ThrottlePreset, type XboxConfig } from "./xbox";

export interface PadInfo {
  index: number;
  id: string;
  mapping: string;
  axes: number;
  buttons: number;
}

/** Onafhankelijke pad-detectie: werkt ook als de bridge uit staat of WS dicht is. */
export function useGamepadStatus(): PadInfo[] {
  const [pads, setPads] = useState<PadInfo[]>([]);
  useEffect(() => {
    const poll = () => {
      const list: PadInfo[] =
        typeof navigator !== "undefined" && navigator.getGamepads
          ? [...navigator.getGamepads()]
              .filter((p): p is Gamepad => !!p?.connected)
              .map((p) => ({ index: p.index, id: p.id, mapping: p.mapping, axes: p.axes.length, buttons: p.buttons.length }))
          : [];
      setPads((prev) => (JSON.stringify(prev) === JSON.stringify(list) ? prev : list));
    };
    poll();
    const t = setInterval(poll, 500);
    window.addEventListener("gamepadconnected", poll);
    window.addEventListener("gamepaddisconnected", poll);
    return () => {
      clearInterval(t);
      window.removeEventListener("gamepadconnected", poll);
      window.removeEventListener("gamepaddisconnected", poll);
    };
  }, []);
  return pads;
}

export function useXboxBridge(
  wsUrl: string,
  cfg: XboxConfig,
  run: boolean,
  manualArm: boolean,
  manualMode: boolean,
  manualOn: boolean,
  manualThrPct: number,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const pads = useGamepadStatus();
  const padInfo = pads[0] ?? null;
  const padName = padInfo?.id ?? null;
  const padLive = pads.length > 0;
  const deviceClass: PadClass = padInfo ? classifyPad(padInfo) : "generic";
  // Effectieve knop-mapping: expliciete keuze wint, anders de default van de klasse.
  const classDefaults: ButtonMap = deviceClass === "rc" ? RC_BUTTONS : XBOX_BUTTONS;
  const effArm = cfg.armButton ?? classDefaults.arm;
  const effMode = cfg.modeButton ?? classDefaults.mode;
  // Expliciete knopkeuze wint van de as (ook "Uit" zet de as uit).
  const effArmAxis = cfg.armButton !== undefined ? -1 : (cfg.armAxis ?? classDefaults.armAxis);
  const effModeAxis = cfg.modeButton !== undefined ? -1 : (cfg.modeAxis ?? classDefaults.modeAxis);
  const effStart = deviceClass === "rc" ? -1 : XBOX_BUTTONS.start;
  const effBack = deviceClass === "rc" ? -1 : XBOX_BUTTONS.back;
  const [wsOpen, setWsOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [padButtons, setPadButtons] = useState<boolean[]>([]);
  const [latchedArm, setLatchedArmState] = useState(false);
  const latchRef = useRef(false);
  const [latchedMode, setLatchedModeState] = useState(false);
  const modeLatchRef = useRef(false);
  const prevStartRef = useRef(false);
  const prevArmBtnRef = useRef(false);
  const prevModeBtnRef = useRef(false);
  // Live-waarden via ref i.p.v. effect-deps: sliders (throttle, expo) mogen
  // NOOIT de WebSocket/sender opnieuw opbouwen mid-stream.
  const inputCfg = useRef({ run, manualOn, manualThr: manualThrPct, manualArm, manualMode, cfg, deviceClass, effArm, effMode, effStart, effBack, effArmAxis, effModeAxis });
  inputCfg.current = { run, manualOn, manualThr: manualThrPct, manualArm, manualMode, cfg, deviceClass, effArm, effMode, effStart, effBack, effArmAxis, effModeAxis };
  const lastPilotRef = useRef<{
    roll: number;
    pitch: number;
    throttle: number;
    yaw: number;
    modeRate: boolean;
    armed: boolean;
  } | null>(null);
  const sentAtRef = useRef(0);
  const lastMonRef = useRef(0);
  const setLatchedArm = (v: boolean) => {
    latchRef.current = v;
    setLatchedArmState(v);
  };
  const [log, setLog] = useState<{ level: LogLevel; message: string; at: string }[]>([]);
  const [rx, setRx] = useState<RxSight[]>([]);
  const [toasts, setToasts] = useState<{ id: number; message: string }[]>([]);
  const toastId = useRef(0);
  // Verbindingsstatus richting backend: "connecting" bij opstarten/retry,
  // "open" bij live-verbinding, "down" bij verlies (met auto-retry + banner).
  const [connState, setConnState] = useState<"connecting" | "open" | "down">("connecting");
  const [attempt, setAttempt] = useState(0);
  const connRef = useRef(connState);
  connRef.current = connState;
  const [status, setStatus] = useState<{
    tx: PortState;
    fc: PortState;
    bridgeHz: number;
    corrupt: number;
    channels: number[];
    link: LinkStats | null;
    linkAt: number | null;
    inputAgeMs: number | null;
    attitude: { roll: number; pitch: number; yaw: number };
    fcSupported: boolean;
    ackCount: number;
    lastTunack: TunAck | null;
    lastPingMs: number | null;
    lastPingAt: number | null;
    txUp: number;
    txDown: number;
  } | null>(null);
  const [raw, setRaw] = useState<{ axes: number[]; btns: number[] } | null>(null);
  const linkAtRef = useRef(0);
  const lastRawRef = useRef(0);

  useEffect(() => {
    // alive-bewaker: een opgeruimde instantie (StrictMode-dubbelmount, retry)
    // mag nooit de opvolger sluiten of een nieuwe poging plannen — dat gaf
    // een zelfinstandhoudende 3s verbindingsflap.
    let alive = true;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    let raf = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const push = (level: LogLevel, message: string) =>
      setLog((l) => [...l.slice(-299), { level, message, at: new Date().toLocaleTimeString() }]);
    const toast = (message: string) => {
      const id = ++toastId.current;
      setToasts((t) => [...t.slice(-2), { id, message }]);
    };
    ws.onopen = () => {
      if (!alive) {
        ws.close();
        return;
      }
      setWsOpen(true);
      if (connRef.current !== "open") {
        setConnState("open");
        push("info", attempt > 0 ? `backend-verbinding hersteld (${wsUrl})` : `verbonden met backend (${wsUrl})`);
      }
    };
    ws.onclose = () => {
      if (!alive) return;
      setWsOpen(false);
      // Alleen bij de overgang open/connecting -> down loggen (geen spam per retry).
      if (connRef.current !== "down") {
        setConnState("down");
        push("error", `backend-verbinding weg (${wsUrl}) — probeer automatisch opnieuw`);
        toast(`Backend-verbinding weg (${wsUrl})`);
      }
      retryTimer = setTimeout(() => {
        if (alive) setAttempt((a) => a + 1);
      }, 3000);
    };
    ws.onmessage = (ev) => {
      let msg: BackendToPc;
      try {
        msg = JSON.parse(String(ev.data)) as BackendToPc;
      } catch {
        return;
      }
      if (msg.t === "status") {
        setStatus((s) => ({
          tx: msg.tx,
          fc: msg.fc,
          bridgeHz: msg.bridgeHz,
          corrupt: msg.corruptFrames,
          channels: s?.channels ?? new Array(16).fill(992),
          link: s?.link ?? null,
          linkAt: s?.linkAt ?? null,
          attitude: s?.attitude ?? { roll: 0, pitch: 0, yaw: 0 },
          fcSupported: msg.fcSupported || (s?.fcSupported ?? false),
          ackCount: s?.ackCount ?? 0,
          lastTunack: s?.lastTunack ?? null,
          lastPingMs: s?.lastPingMs ?? null,
          lastPingAt: s?.lastPingAt ?? null,
          txUp: msg.txUpBytes,
          txDown: msg.txDownBytes,
          inputAgeMs: msg.inputAgeMs,
        }));
      } else if (msg.t === "ack") {
        setStatus((s) => (s ? { ...s, fcSupported: true, ackCount: s.ackCount + 1 } : s));
        push("info", "FC Ack ontvangen — tuning live");
      } else if (msg.t === "tunack") {
        const a = msg.ack;
        const detail =
          a.kind === "pid"
            ? `Pid as${a.axis} kp=${a.kp} ki=${a.ki} kd=${a.kd} ${a.ok ? "ok" : "MISLUKT"}`
            : `Filter gyro=${a.gyro} lpf1=${a.lpf1} lpf2=${a.lpf2} ${a.ok ? "ok" : "MISLUKT"}`;
        setStatus((s) => (s ? { ...s, fcSupported: true, ackCount: s.ackCount + 1, lastTunack: a } : s));
        push(a.ok ? "info" : "error", `FC TunAck (0x7F04): ${detail}`);
      } else if (msg.t === "ping") {
        const hex = msg.bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
        if (msg.rttMs !== null) {
          setStatus((s) => (s ? { ...s, lastPingMs: msg.rttMs, lastPingAt: Date.now() } : s));
        }
        push("debug", `ping-echo (0x7F03) seq=${msg.seq}${msg.rttMs !== null ? ` RTT ${msg.rttMs}ms` : " (geen match)"} ${msg.bytes.length}B: ${hex}`);
      } else if (msg.t === "channels") {
        // Genegeerd: de monitor komt uit lokaal verstuurde input (nul latentie).
        // De backend-echo blijft bestaan voor andere consumers.
      } else if (msg.t === "link") {
        linkAtRef.current = Date.now();
        setStatus((s) => (s ? { ...s, link: msg.stats, linkAt: linkAtRef.current } : s));
      } else if (msg.t === "attitude") {
        setStatus((s) => (s ? { ...s, attitude: { roll: msg.roll, pitch: msg.pitch, yaw: msg.yaw } } : s));
      } else if (msg.t === "banner" || msg.t === "log") {
        push(msg.t === "banner" ? "error" : msg.level, msg.t === "banner" ? `[${msg.port}] ${msg.message}` : msg.message);
        if (msg.t === "banner") toast(`[${msg.port}] ${msg.message}`);
      } else if (msg.t === "rx") {
        const sight = msg.sight;
        setRx((r) => [...r.slice(-199), sight]);
      }
    };
    const loop = () => {
      raf = requestAnimationFrame(loop);
      // Pad-knoppen altijd bijwerken zodat ze in de UI oplichten.
      const pad = findPad();
      const pressed = pad ? pad.buttons.map((b) => b.pressed) : [];
      setPadButtons(pressed);
      const now = Date.now();
      // Raw-uitlezing (±7Hz) voor diagnose: wat komt er écht binnen?
      if (pad && now - lastRawRef.current >= 150) {
        lastRawRef.current = now;
        setRaw({
          axes: [...pad.axes].map((v) => Math.round(v * 1000) / 1000),
          btns: pressed.map((p, i) => (p ? i : -1)).filter((i) => i >= 0),
        });
      } else if (!pad) {
        setRaw(null);
      }
      // Monitor (±30Hz) uit lokaal verstuurde input: geen backend-retour nodig.
      if (lastPilotRef.current && now - lastMonRef.current >= 33) {
        lastMonRef.current = now;
        const lp = lastPilotRef.current;
        const ch = new Array(16).fill(CRSF_MID);
        ch[CH_ROLL] = stickToCrsf(lp.roll);
        ch[CH_PITCH] = stickToCrsf(lp.pitch);
        ch[CH_THROTTLE] = throttleToCrsf(lp.throttle);
        ch[CH_YAW] = stickToCrsf(lp.yaw);
        ch[CH_MODE] = switchToCrsf(lp.modeRate);
        ch[CH_ARM] = switchToCrsf(lp.armed);
        setStatus((s) => (s ? { ...s, channels: ch } : s));
      }
      setStreaming(now - sentAtRef.current < 150);
    };
    raf = requestAnimationFrame(loop);
    // Vaste 100Hz-zender, los van display-vsync: stabiele cadans richting backend.
    // (rAF zit vast aan 60/120Hz vsync-judder; dit interval niet.)
    const sender = setInterval(() => {
      const ic = inputCfg.current;
      if (ws.readyState !== WebSocket.OPEN || !ic.run) return;
      // Handmatige bench-modus: vaste kanalen, geen controller nodig.
      // Throttle hard afgetopt op 10% (bench-veiligheid).
      if (ic.manualOn) {
        const thr = Math.min(10, Math.max(0, ic.manualThr)) / 100;
        const out = { roll: 0, pitch: 0, throttle: thr, yaw: 0, modeRate: ic.manualMode, armed: ic.manualArm };
        ws.send(JSON.stringify({ t: "input", ...out }));
        lastPilotRef.current = out;
        sentAtRef.current = Date.now();
        return;
      }
      const pad = findPad();
      if (!pad) return; // geen pad: niets sturen -> backend-failsafe
      const p = gamepadToPilot(
        pad,
        ic.cfg,
        { arm: ic.effArm, mode: ic.effMode, start: ic.effStart, back: ic.effBack, armAxis: ic.effArmAxis, modeAxis: ic.effModeAxis },
        ic.deviceClass,
      );
      let armed: boolean;
      let modeRate: boolean;
      if (ic.deviceClass === "rc") {
        // Houd-schakelaars (CH5/CH9): direct niveau, géén flank-toggle.
        armed = p.armedHold || ic.manualArm;
        modeRate = p.modeRate || ic.manualMode;
      } else {
        // Knoppen: stijgende flank flipt de vergrendeling — geen hold-gedrag meer,
        // ongeacht welke knop erop gemapt is. Start/Back blijven absolute aan/uit.
        if (p.armedHold && !prevArmBtnRef.current) {
          const v = !latchRef.current;
          latchRef.current = v;
          setLatchedArmState(v);
          push("warn", v ? "arm AAN (toggle)" : "arm UIT (toggle)");
        }
        prevArmBtnRef.current = p.armedHold;
        if (p.modeRate && !prevModeBtnRef.current) {
          const v = !modeLatchRef.current;
          modeLatchRef.current = v;
          setLatchedModeState(v);
          push("info", v ? "mode RATE (toggle)" : "mode ANGLE (toggle)");
        }
        prevModeBtnRef.current = p.modeRate;
        armed = latchRef.current || ic.manualArm;
        modeRate = modeLatchRef.current || ic.manualMode;
      }
      if (p.startPressed && !prevStartRef.current) {
        latchRef.current = true;
        setLatchedArmState(true);
        push("warn", "arm AAN via Start (Back = uit)");
      }
      if (p.backPressed && latchRef.current) {
        latchRef.current = false;
        setLatchedArmState(false);
        push("warn", "arm UIT via Back");
      }
      prevStartRef.current = p.startPressed;
      const out = {
        roll: p.roll,
        pitch: p.pitch,
        throttle: p.throttle,
        yaw: p.yaw,
        modeRate,
        armed,
      };
      ws.send(JSON.stringify({ t: "input", ...out }));
      lastPilotRef.current = out;
      sentAtRef.current = Date.now();
    }, 10);
    // Link als verbroken markeren als er >2s geen telemetrie binnenkomt.
    const linkWatch = setInterval(() => {
      if (linkAtRef.current && Date.now() - linkAtRef.current > 2000) {
        linkAtRef.current = 0;
        setStatus((s) => (s ? { ...s, link: null, linkAt: null } : s));
      }
    }, 1000);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      clearInterval(sender);
      clearInterval(linkWatch);
      if (retryTimer) clearTimeout(retryTimer);
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl, attempt]);

  const send = (obj: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(obj));
  };
  const sendFc = (cmd: FromPc) => send({ t: "fc", cmd });
  const sendTune = (cmd: FromPc) => send({ t: "tune", cmd });
  const reconnect = (port: "tx" | "fc") => send({ t: "reconnect", port });
  const setTxBaud = (baud: number) => send({ t: "setTxBaud", baud });
  const clearRx = () => setRx([]);
  /** Handmatige reconnect: verbreek en start een verse poging. */
  const retryNow = () => {
    try {
      wsRef.current?.close();
    } catch {
      /* genegeerd — onclose plant de retry */
    }
    setAttempt((a) => a + 1);
  };
  const dismissToast = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

  return { padName, padLive, pads, deviceClass, effArm, effMode, effArmAxis, effModeAxis, wsOpen, connState, retryCount: attempt, retryNow, streaming, padButtons, raw, latchedArm, setLatchedArm, latchedMode, log, toasts, dismissToast, rx, clearRx, status, wsUrl, sendFc, sendTune, setTxBaud, reconnect };
}

export function useXboxConfigState(): [XboxConfig, (p: Partial<XboxConfig>) => void] {
  const [cfg, setCfg] = useState<XboxConfig>(DEFAULT_XBOX_CONFIG);
  return [cfg, (p) => setCfg((c) => ({ ...c, ...p }))];
}

export type { ThrottlePreset };
export type { FromPc };
