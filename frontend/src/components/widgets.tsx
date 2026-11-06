import type { LinkStats, LogLevel, PortState } from "@ground-station/shared";
import { CRSF_MAX, CRSF_MID, CRSF_MIN } from "@ground-station/shared";

export function StatusBar(props: {
  tx: PortState;
  fc: PortState;
  bridgeHz: number;
  link: LinkStats | null;
  armed: boolean;
  corrupt: number;
  txUp: number;
  txDown: number;
}) {
  const dot = (open: boolean) => (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: 5,
        background: open ? "#2ecc71" : "#e74c3c",
        marginRight: 6,
      }}
    />
  );
  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", padding: "8px 12px", background: "#111", color: "#eee", fontSize: 13 }}>
      <span>
        {dot(props.tx.open)}TX {props.tx.name}@{props.tx.baud} {props.tx.error ? `(${props.tx.error})` : ""}
      </span>
      <span>
        {dot(props.fc.open)}FC {props.fc.name}@{props.fc.baud} {props.fc.error ? `(${props.fc.error})` : ""}
      </span>
      <span>bridge {props.bridgeHz}Hz</span>
      <span>
        link {props.link ? `${props.link.uplinkRssiDbm}dBm LQ${props.link.uplinkLq}% / DL ${props.link.downlinkRssiDbm}dBm LQ${props.link.downlinkLq}%` : "—"}
      </span>
      <span style={{ color: props.armed ? "#e74c3c" : "#2ecc71", fontWeight: "bold" }}>
        {props.armed ? "ARMED" : "DISARMED"}
      </span>
      <span>corrupt {props.corrupt}</span>
      <span title="bytes verstuurd naar TX / bytes terug van TX">
        TX {props.txUp >= 1024 ? `${(props.txUp / 1024).toFixed(1)}kB` : `${props.txUp}B`}↑{" "}
        {props.txDown >= 1024 ? `${(props.txDown / 1024).toFixed(1)}kB` : `${props.txDown}B`}↓
      </span>
    </div>
  );
}

const NAMES = ["roll", "pitch", "thr", "yaw", "mode", "—", "—", "—", "arm", "—", "—", "—", "—", "—", "—", "—"];

export function ChannelMonitor(props: { channels: number[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 8 }}>
      {props.channels.map((v, i) => {
        // Throttle (ch3) is 0..100%, sticks zijn -100..+100%.
        const isThrottle = i === 2;
        const pct = isThrottle
          ? Math.min(100, Math.max(0, Math.round(((v - CRSF_MIN) / (CRSF_MAX - CRSF_MIN)) * 100)))
          : Math.round(((v - CRSF_MID) / (CRSF_MAX - CRSF_MID)) * 100);
        const isSwitch = i === 4 || i === 8;
        return (
          <div key={i} style={{ background: "#1c1c1c", color: "#eee", padding: 6, borderRadius: 6, fontSize: 11 }}>
            <div>
              ch{i + 1} {NAMES[i]} {isSwitch ? "⚑" : ""}
            </div>
            <div style={{ height: 8, background: "#333", borderRadius: 4, margin: "4px 0" }}>
              <div
                style={{
                  width: isThrottle ? `${pct}%` : `${Math.min(100, Math.abs(pct))}%`,
                  marginLeft: isThrottle ? "0" : pct < 0 ? `${100 - Math.min(100, Math.abs(pct))}%` : "50%",
                  height: 8,
                  background: isSwitch ? "#f39c12" : "#3498db",
                  borderRadius: 4,
                }}
              />
            </div>
            <div>
              {v} ({pct > 0 ? "+" : ""}
              {pct})
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Horizon(props: { roll: number; pitch: number; yaw: number }) {
  const r = (props.roll * 180) / Math.PI;
  const p = (props.pitch * 180) / Math.PI;
  const y = (props.yaw * 180) / Math.PI;
  return (
    <div style={{ background: "#0b2033", borderRadius: 8, overflow: "hidden", width: 280, height: 180, position: "relative" }}>
      <div
        style={{
          position: "absolute",
          inset: -60,
          transform: `rotate(${-r}deg) translateY(${p * 2}px)`,
          background: "linear-gradient(to bottom, #3a87c8 50%, #7a5a33 50%)",
        }}
      />
      <div style={{ position: "absolute", left: 0, right: 0, top: "50%", height: 2, background: "#ffd23f" }} />
      <div style={{ position: "absolute", bottom: 6, left: 8, color: "#fff", fontSize: 12 }}>
        R {r.toFixed(1)}° P {p.toFixed(1)}° Y {y.toFixed(1)}°
      </div>
    </div>
  );
}

export function LogWindow(props: {
  logs: { level: LogLevel; message: string; at: string }[];
  level: LogLevel;
  setLevel: (l: LogLevel) => void;
}) {
  const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const rows = props.logs.filter((l) => order[l.level] >= order[props.level]).slice(-120);
  return (
    <div style={{ background: "#0d0d0d", color: "#ddd", borderRadius: 8, padding: 8 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
        {(["debug", "info", "warn", "error"] as LogLevel[]).map((l) => (
          <button
            key={l}
            onClick={() => props.setLevel(l)}
            style={{ background: props.level === l ? "#555" : "#222", color: "#fff", border: 0, borderRadius: 4 }}
          >
            {l}
          </button>
        ))}
      </div>
      <div style={{ height: 160, overflowY: "auto", fontFamily: "monospace", fontSize: 12 }}>
        {rows.map((l, i) => (
          <div key={i} style={{ color: l.level === "error" ? "#ff6b6b" : l.level === "warn" ? "#ffd23f" : "#ddd" }}>
            [{l.at}] [{l.level}] {l.message}
          </div>
        ))}
      </div>
    </div>
  );
}
