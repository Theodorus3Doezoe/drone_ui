import { memo, useEffect, useRef, useState } from "react";
import type { LinkStats, LogLevel, PortState } from "@ground-station/shared";
import { CRSF_MAX, CRSF_MID, CRSF_MIN, TX_BAUD_PRESETS } from "@ground-station/shared";

/* Kleine inline SVG-iconen (geen emoji, geen extra deps). Decoratief: aria-hidden. */
export function Icon({
  d,
  size = 16,
  color = "currentColor",
}: {
  d: string;
  size?: number;
  color?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d={d} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const PATHS = {
  warn: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  info: "M12 16v-5m0-3h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  error: "M12 8v5m0 3h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z",
  plug: "M9 7V3m6 4V3M7 7h10v4a5 5 0 0 1-10 0V7Zm5 9v5",
  link: "M10 14a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.1M14 10a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.1",
  filter: "M3 5h18l-7 8v6l-4 2v-8L3 5Z",
};

function PortDot({ open }: { open: boolean }) {
  return <span className="dot" style={{ background: open ? "var(--ok)" : "var(--danger)" }} aria-hidden="true" />;
}

export function StatusBar(props: {
  tx: PortState;
  fc: PortState;
  bridgeHz: number;
  link: LinkStats | null;
  armed: boolean;
  corrupt: number;
  txUp: number;
  txDown: number;
  pingRttMs: number | null;
}) {
  const fmt = (b: number) => (b >= 1024 ? `${(b / 1024).toFixed(1)}kB` : `${b}B`);
  return (
    <div className="card">
      <div className="card__body">
        <div className="stat-grid">
          <div className="stat">
            <div className="stat__label">
              <PortDot open={props.tx.open} /> TX-serieel
            </div>
            <div
              className={`stat__value ${props.tx.open ? "stat__value--ok" : "stat__value--bad"}`}
              title={props.tx.error || props.tx.name}
            >
              {props.tx.open ? `${props.tx.name} @${props.tx.baud}` : (props.tx.error ?? "gesloten")}
            </div>
          </div>
          <div className="stat">
            <div className="stat__label">
              <PortDot open={props.fc.open} /> FC-serieel
            </div>
            <div
              className={`stat__value ${props.fc.open ? "stat__value--ok" : "stat__value--bad"}`}
              title={props.fc.error || props.fc.name}
            >
              {props.fc.open ? `${props.fc.name} @${props.fc.baud}` : (props.fc.error ?? "gesloten")}
            </div>
          </div>
          <div className="stat">
            <div className="stat__label">Ping RTT</div>
            <div className="stat__value stat__value--rtt" title="ELRS-heartbeat PC → TX → RX → FC → retour, 1Hz">
              {props.pingRttMs !== null ? `${props.pingRttMs} ms` : "—"}
            </div>
          </div>
          <div className="stat">
            <div className="stat__label">Bridge</div>
            <div className="stat__value">{props.bridgeHz} Hz</div>
          </div>
          <div className="stat">
            <div className="stat__label">Link TX↔RX</div>
            <div className="stat__value" title="uplink RSSI / LQ — downlink RSSI / LQ">
              {props.link
                ? `${props.link.uplinkRssiDbm}dBm ${props.link.uplinkLq}% / ${props.link.downlinkRssiDbm}dBm ${props.link.downlinkLq}%`
                : "— geen link —"}
            </div>
          </div>
          <div className="stat">
            <div className="stat__label">Verkeer TX</div>
            <div className="stat__value" title="bytes verstuurd naar TX / bytes terug van TX">
              {fmt(props.txUp)} ↑ {fmt(props.txDown)} ↓
            </div>
          </div>
          <div className="stat">
            <div className="stat__label">Corrupte frames</div>
            <div className={`stat__value ${props.corrupt > 0 ? "stat__value--warn" : ""}`}>{props.corrupt}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

const NAMES = ["roll", "pitch", "thr", "yaw", "mode", "—", "—", "—", "arm", "—", "—", "—", "—", "—", "—", "—"];

export const ChannelMonitor = memo(function ChannelMonitor(props: { channels: number[] }) {
  return (
    <div className="channels" role="group" aria-label="Kanaalwaarden">
      {props.channels.map((v, i) => {
        // Throttle (ch3) is 0..100%, sticks zijn -100..+100%.
        const isThrottle = i === 2;
        const pct = isThrottle
          ? Math.min(100, Math.max(0, Math.round(((v - CRSF_MIN) / (CRSF_MAX - CRSF_MIN)) * 100)))
          : Math.round(((v - CRSF_MID) / (CRSF_MAX - CRSF_MID)) * 100);
        const isSwitch = i === 4 || i === 8;
        const hot = isSwitch && v > 1500;
        const left = isThrottle ? 0 : pct < 0 ? 50 - Math.min(50, Math.abs(pct) / 2) : 50;
        const width = isThrottle ? pct : Math.min(50, Math.abs(pct) / 2);
        return (
          <div key={i} className={`ch${isSwitch ? " ch--switch" : ""}${hot ? " ch--hot" : ""}`}>
            <div className="ch__top">
              <span>
                ch{i + 1} {NAMES[i]}
              </span>
              {isSwitch && (
                <span className="ch__flag" aria-hidden="true">
                  SW
                </span>
              )}
            </div>
            <div
              className={`ch__bar${isThrottle ? "" : " ch__bar--center"}`}
              role="img"
              aria-label={`Kanaal ${i + 1} ${NAMES[i]}: ${v}, ${pct} procent`}
            >
              <div className="ch__fill" style={{ left: `${left}%`, width: `${width}%` }} />
            </div>
            <div className="ch__val">
              {v} <span>({pct > 0 ? `+${pct}` : pct})</span>
            </div>
          </div>
        );
      })}
    </div>
  );
});

export function Horizon(props: { roll: number; pitch: number; yaw: number }) {
  const rDeg = (props.roll * 180) / Math.PI;
  const pDeg = (props.pitch * 180) / Math.PI;
  const yDeg = (props.yaw * 180) / Math.PI;
  // SVG artificial horizon: 280x180 viewport, horizonlijn roteert met -roll,
  // verschuift met pitch (ca. 2px per graad).
  return (
    <svg
      className="horizon"
      width="280"
      height="180"
      viewBox="0 0 280 180"
      role="img"
      aria-label={`Kunstmatige horizon: rol ${rDeg.toFixed(1)} graden, pitch ${pDeg.toFixed(1)} graden, yaw ${yDeg.toFixed(1)} graden`}
    >
      <defs>
        <clipPath id="horizon-clip">
          <rect x="0" y="0" width="280" height="180" rx="6" />
        </clipPath>
      </defs>
      <g clipPath="url(#horizon-clip)">
        <g transform={`rotate(${-rDeg} 140 90) translate(0 ${(pDeg * 2).toFixed(1)})`}>
          <rect x="-160" y="-250" width="600" height="340" fill="#2f6da3" />
          <rect x="-160" y="90" width="600" height="340" fill="#6e5233" />
          <rect x="-160" y="88" width="600" height="3" fill="#e8eef4" opacity="0.85" />
          {/* pitch-ladder, elke 10 graden */}
          {[-20, -10, 10, 20].map((d) => (
            <g key={d}>
              <rect x={120} y={90 - d * 2 - 1} width={40} height={2} fill="#e8eef4" opacity="0.55" />
              <text x={166} y={90 - d * 2 + 4} fontSize="9" fill="#e8eef4" opacity="0.7" fontFamily="monospace">
                {Math.abs(d)}
              </text>
            </g>
          ))}
        </g>
        {/* vaste vliegtuigmarkering */}
        <g stroke="#ffd23f" strokeWidth={3} strokeLinecap="round">
          <line x1="70" y1="90" x2="118" y2="90" />
          <line x1="162" y1="90" x2="210" y2="90" />
          <circle cx="140" cy="90" r="3.5" fill="#ffd23f" stroke="none" />
        </g>
        {/* roll-schaal boven */}
        <text x="140" y="16" textAnchor="middle" fontSize="10" fill="#e8eef4" fontFamily="monospace" opacity="0.85">
          {rDeg >= 0 ? "+" : ""}
          {rDeg.toFixed(0)}°
        </text>
      </g>
    </svg>
  );
}

export function LogWindow(props: {
  logs: { level: LogLevel; message: string; at: string }[];
  level: LogLevel;
  setLevel: (l: LogLevel) => void;
}) {  const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const rows = props.logs.filter((l) => order[l.level] >= order[props.level]).slice(-120);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  return (
    <div className="log">
      <div className="log__filters" role="group" aria-label="Logniveau-filter">
        {(["debug", "info", "warn", "error"] as LogLevel[]).map((l) => (
          <button
            key={l}
            onClick={() => props.setLevel(l)}
            className={`btn btn--small btn--ghost${props.level === l ? " is-active" : ""}`}
            aria-pressed={props.level === l}
          >
            {l}
          </button>
        ))}
      </div>
      <div
        ref={bodyRef}
        className="log__body"
        role="log"
        aria-live="off"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {rows.length === 0 && <div className="log__row--debug">— nog geen meldingen —</div>}
        {rows.map((l, i) => (
          <div key={i} className={`log__row--${l.level}`}>
            <span className="log__time">[{l.at}]</span> [{l.level}] {l.message}
          </div>
        ))}
      </div>
    </div>
  );
}

/** TX-baudkiezer: presets + eigen waarde. Toont de actieve baud uit de status. */
export function BaudSelect(props: { activeBaud: number | null; onApply: (baud: number) => void }) {
  const presets = [...TX_BAUD_PRESETS];
  const [mode, setMode] = useState<string>(() =>
    props.activeBaud !== null && (presets as number[]).includes(props.activeBaud)
      ? String(props.activeBaud)
      : "custom",
  );
  const [custom, setCustom] = useState<string>(
    props.activeBaud !== null && !(presets as number[]).includes(props.activeBaud)
      ? String(props.activeBaud)
      : "",
  );
  const [lastActive, setLastActive] = useState(props.activeBaud);
  // Backend is leidend: als de actieve baud extern verandert, volgen.
  if (props.activeBaud !== lastActive) {
    setLastActive(props.activeBaud);
    if (props.activeBaud !== null && (presets as number[]).includes(props.activeBaud)) {
      setMode(String(props.activeBaud));
    } else {
      setMode("custom");
      if (props.activeBaud !== null) setCustom(String(props.activeBaud));
    }
  }
  const chosen = mode === "custom" ? Number(custom) : Number(mode);
  const valid = Number.isInteger(chosen) && chosen >= 1200 && chosen <= 2000000;
  const dirty =
    props.activeBaud === null || (valid && chosen !== props.activeBaud);
  return (
    <span className="field">
      <span title="Seriële snelheid richting ELRS-TX-module. Omzetten heropent de poort.">
        TX-baud {props.activeBaud !== null ? <span className="mono">({props.activeBaud})</span> : "(…)"}
      </span>
      <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="TX-baudrate preset">
        {presets.map((b) => (
          <option key={b} value={String(b)}>
            {b}{b === 921600 ? " (standaard)" : ""}
          </option>
        ))}
        <option value="custom">custom…</option>
      </select>
      {mode === "custom" && (
        <input
          type="number"
          min={1200}
          max={2000000}
          step={1}
          value={custom}
          placeholder="bvb 57600"
          onChange={(e) => setCustom(e.target.value)}
          aria-label="Eigen TX-baudrate"
          style={{ width: 100 }}
        />
      )}
      <button
        className="btn btn--small"
        disabled={!valid || !dirty}
        title={valid ? `Zet TX-baud op ${chosen} (poort heropent)` : "Vul een geldige baudrate in (1200–2000000)"}
        onClick={() => {
          if (valid) props.onApply(chosen);
        }}
      >
        Toepassen
      </button>
    </span>
  );
}

/** Kortstondige foutmeldingen (backend-banners, verbindingsverlies). Zelfsluitend. */
export function ToastStack(props: { toasts: { id: number; message: string }[]; onDismiss: (id: number) => void }) {
  if (props.toasts.length === 0) return null;
  return (
    <div className="toasts" aria-live="assertive">
      {props.toasts.map((t) => (
        <Toast key={t.id} id={t.id} message={t.message} onDismiss={props.onDismiss} />
      ))}
    </div>
  );
}

function Toast(props: { id: number; message: string; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const t = setTimeout(() => props.onDismiss(props.id), 6000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.id]);
  return (
    <div className="toast alert--error" role="alert">
      <Icon d={PATHS.error} color="var(--danger)" />
      <div className="toast__msg">{props.message}</div>
      <button className="btn btn--ghost btn--small" onClick={() => props.onDismiss(props.id)} aria-label="Melding sluiten">
        ×
      </button>
    </div>
  );
}
