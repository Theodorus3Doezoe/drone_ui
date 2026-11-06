import { useState } from "react";
import type { FromPc } from "@ground-station/shared";

const DEFAULTS = {
  roll: { kp: 0.0, ki: 0.0, kd: 0.0 },
  pitch: { kp: 0.0, ki: 0.0, kd: 0.0 },
  yaw: { kp: 0.0, ki: 0.0, kd: 0.0 },
  gyro: 100,
  dtermLpf1: 150,
  dtermLpf2: 250,
};

export function Tuning(props: { fcSupported: boolean; sendFc: (cmd: FromPc) => void }) {
  const [pid, setPid] = useState(DEFAULTS);
  const [pending, setPending] = useState(false);
  const disabled = !props.fcSupported && pending;
  const hint = !props.fcSupported ? "FC ondersteunt dit nog niet (geen Ack ontvangen) — velden defensief grijs." : "";

  const set = (axis: "roll" | "pitch" | "yaw", k: "kp" | "ki" | "kd", v: number) =>
    setPid((p) => ({ ...p, [axis]: { ...p[axis], [k]: v } }));

  const sendAll = () => {
    (["roll", "pitch", "yaw"] as const).forEach((a, axis) => {
      props.sendFc({ kind: "setPid", axis, kp: pid[a].kp, ki: pid[a].ki, kd: pid[a].kd });
    });
    props.sendFc({ kind: "setFilter", gyroCutoff: pid.gyro, dtermCutoffLpf1: pid.dtermLpf1, dtermCutoffLpf2: pid.dtermLpf2 });
    setPending(true);
    setTimeout(() => setPending(false), 1500);
  };

  return (
    <div style={{ opacity: props.fcSupported ? 1 : 0.55 }}>
      <p style={{ fontSize: 12, color: "#a00" }}>{hint}</p>
      {(["roll", "pitch", "yaw"] as const).map((a) => (
        <div key={a} style={{ marginBottom: 8 }}>
          <strong>{a}</strong>
          {(["kp", "ki", "kd"] as const).map((k) => (
            <label key={k} style={{ marginLeft: 12, fontSize: 12 }}>
              {k}
              <input
                type="number"
                step="0.001"
                value={pid[a][k]}
                disabled={disabled}
                onChange={(e) => set(a, k, Number(e.target.value))}
                style={{ width: 80, marginLeft: 4 }}
              />
            </label>
          ))}
        </div>
      ))}
      <div style={{ marginBottom: 8, fontSize: 12 }}>
        <label>
          gyro cutoff
          <input
            type="number"
            value={pid.gyro}
            disabled={disabled}
            onChange={(e) => setPid((p) => ({ ...p, gyro: Number(e.target.value) }))}
            style={{ width: 70, marginLeft: 4 }}
          />
        </label>
        <label style={{ marginLeft: 12 }}>
          dterm lpf1
          <input
            type="number"
            value={pid.dtermLpf1}
            disabled={disabled}
            onChange={(e) => setPid((p) => ({ ...p, dtermLpf1: Number(e.target.value) }))}
            style={{ width: 70, marginLeft: 4 }}
          />
        </label>
        <label style={{ marginLeft: 12 }}>
          dterm lpf2
          <input
            type="number"
            value={pid.dtermLpf2}
            disabled={disabled}
            onChange={(e) => setPid((p) => ({ ...p, dtermLpf2: Number(e.target.value) }))}
            style={{ width: 70, marginLeft: 4 }}
          />
        </label>
      </div>
      <button onClick={sendAll}>verstuur live</button>
      <button onClick={() => setPid(DEFAULTS)} style={{ marginLeft: 8 }}>
        reset naar default
      </button>
      <button onClick={() => props.sendFc({ kind: "arm" })} style={{ marginLeft: 8 }}>
        arm
      </button>
      <button onClick={() => props.sendFc({ kind: "disarm" })} style={{ marginLeft: 8 }}>
        disarm
      </button>
    </div>
  );
}
