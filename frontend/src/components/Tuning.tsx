import { useState } from "react";
import type { FromPc, TunAck } from "@ground-station/shared";

const DEFAULTS = {
  roll: { kp: 0.0, ki: 0.0, kd: 0.0 },
  pitch: { kp: 0.0, ki: 0.0, kd: 0.0 },
  yaw: { kp: 0.0, ki: 0.0, kd: 0.0 },
  gyro: 100,
  dtermLpf1: 150,
  dtermLpf2: 250,
};

type Axis = "roll" | "pitch" | "yaw";
type Gain = "kp" | "ki" | "kd";

export function Tuning(props: {
  fcSupported: boolean;
  sendFc: (cmd: FromPc) => void;
  sendTune: (cmd: FromPc) => void;
  lastAck?: TunAck | null;
}) {
  const [pid, setPid] = useState(DEFAULTS);
  const [pending, setPending] = useState(false);
  const disabled = pending;
  const hint = !props.fcSupported
    ? "Nog geen TunAck (0x7F04) via ELRS — stuur een tuning; de FC bevestigt hieronder."
    : "";

  const set = (axis: Axis, k: Gain, v: number) =>
    setPid((p) => ({ ...p, [axis]: { ...p[axis], [k]: v } }));

  const sendAll = () => {
    (["roll", "pitch", "yaw"] as const).forEach((a, axis) => {
      props.sendTune({ kind: "setPid", axis, kp: pid[a].kp, ki: pid[a].ki, kd: pid[a].kd });
    });
    props.sendTune({ kind: "setFilter", gyroCutoff: pid.gyro, dtermCutoffLpf1: pid.dtermLpf1, dtermCutoffLpf2: pid.dtermLpf2 });
    setPending(true);
    setTimeout(() => setPending(false), 1500);
  };

  return (
    <div>
      {hint && (
        <p className="fc-hint" role="status">
          {hint}
        </p>
      )}
      {props.lastAck && (
        <p className="mono" role="status" style={{ fontSize: 12, color: props.lastAck.ok ? "var(--ok)" : "var(--danger)" }}>
          FC-bevestiging (0x7F04):{" "}
          {props.lastAck.kind === "pid"
            ? `Pid as${props.lastAck.axis} kp=${props.lastAck.kp} ki=${props.lastAck.ki} kd=${props.lastAck.kd}`
            : `Filter gyro=${props.lastAck.gyro} lpf1=${props.lastAck.lpf1} lpf2=${props.lastAck.lpf2}`}{" "}
          {props.lastAck.ok ? "— toegepast" : "— MISLUKT"}
        </p>
      )}
      <div className="pid-grid">
        {(["roll", "pitch", "yaw"] as const).map((a) => (
          <div key={a} className="pid-card">
            <h4>{a}</h4>
            {(["kp", "ki", "kd"] as const).map((k) => (
              <div key={k} className="pid-row">
                <label htmlFor={`pid-${a}-${k}`}>{k}</label>
                <input
                  type="range"
                  min={0}
                  max={k === "kp" ? 2 : 1}
                  step={0.001}
                  value={pid[a][k]}
                  disabled={disabled}
                  onChange={(e) => set(a, k, Number(e.target.value))}
                  aria-label={`${a} ${k} (schuif)`}
                />
                <input
                  id={`pid-${a}-${k}`}
                  type="number"
                  step="0.001"
                  min={0}
                  value={pid[a][k]}
                  disabled={disabled}
                  onChange={(e) => set(a, k, Number(e.target.value))}
                />
              </div>
            ))}
          </div>
        ))}
        <div className="pid-card">
          <h4>filters</h4>
          {(
            [
              ["gyro", "gyro cutoff", 10, 500],
              ["dtermLpf1", "dterm lpf1", 10, 500],
              ["dtermLpf2", "dterm lpf2", 10, 500],
            ] as const
          ).map(([key, label, min, max]) => (
            <div key={key} className="pid-row">
              <label htmlFor={`flt-${key}`} title={label}>
                {key === "gyro" ? "gy" : key === "dtermLpf1" ? "d1" : "d2"}
              </label>
              <input
                type="range"
                min={min}
                max={max}
                step={1}
                value={pid[key]}
                disabled={disabled}
                onChange={(e) => setPid((p) => ({ ...p, [key]: Number(e.target.value) }))}
                aria-label={`${label} (schuif)`}
              />
              <input
                id={`flt-${key}`}
                type="number"
                value={pid[key]}
                disabled={disabled}
                onChange={(e) => setPid((p) => ({ ...p, [key]: Number(e.target.value) }))}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="tuning-actions" style={{ marginTop: 10 }}>
        <button className="btn btn--primary btn--small" onClick={sendAll}>
          Verstuur live
        </button>
        <button className="btn btn--small" onClick={() => setPid(DEFAULTS)}>
          Reset
        </button>
        <span style={{ flex: 1 }} aria-hidden="true" />
        <button className="btn btn--danger btn--small" onClick={() => props.sendFc({ kind: "arm" })}>
          Arm
        </button>
        <button className="btn btn--small" onClick={() => props.sendFc({ kind: "disarm" })}>
          Disarm
        </button>
      </div>
    </div>
  );
}
