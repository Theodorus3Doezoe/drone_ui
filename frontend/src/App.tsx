import { useEffect, useState } from "react";
import { useXboxBridge, useXboxConfigState } from "./hooks";
import { ChannelMonitor, Horizon, LogWindow, StatusBar } from "./components/widgets";
import { Tuning } from "./components/Tuning";
import { RC_LEGEND, XBOX_LEGEND } from "./xbox";
import type { LogLevel } from "@ground-station/shared";

const WS_URL = `ws://${window.location.hostname}:8080`;
const BTN_NAMES = ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "Back", "Start", "L3", "R3", "DU", "DD", "DL", "DR"];

export default function App() {
  const [run, setRun] = useState(false);
  const [cfg, setCfg] = useXboxConfigState();
  const [manualArm, setManualArm] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [manualOn, setManualOn] = useState(false);
  const [manualThr, setManualThr] = useState(0);
  const [tabHidden, setTabHidden] = useState(
    typeof document !== "undefined" ? document.hidden : false,
  );
  useEffect(() => {
    const onVis = () => setTabHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  const staleMs = status?.inputAgeMs ?? null;
  const stale = staleMs !== null && staleMs > 500;
  const [level, setLevel] = useState<LogLevel>("info");
  const { padName, padLive, pads, deviceClass, effArm, effMode, effArmAxis, effModeAxis, wsOpen, streaming, padButtons, raw, latchedArm, setLatchedArm, log, status, sendFc, reconnect } = useXboxBridge(
    WS_URL,
    cfg,
    run,
    manualArm,
    manualMode,
    manualOn,
    manualThr,
  );

  const channels = status?.channels ?? new Array(16).fill(992);
  const armed = (channels[8] ?? 992) > 1500;
  const rate = (channels[4] ?? 992) > 1500;
  const linked = !!status?.link;
  const classLabel = deviceClass === "rc" ? "RC-remote" : deviceClass === "xbox" ? "Xbox-controller" : "Controller";
  const legend = deviceClass === "rc" ? RC_LEGEND : XBOX_LEGEND;
  const btnCount = Math.max(16, pads[0]?.buttons ?? 16);
  const btnIndices = Array.from({ length: btnCount }, (_, i) => i);
  const axCount = Math.max(9, pads[0]?.axes ?? 9);
  const axIndices = Array.from({ length: axCount }, (_, i) => i);
  const autoName = (d: number) => (d < 0 ? "uit" : `B${d}`);
  const autoAxName = (d: number) => (d < 0 ? "uit" : `A${d} (CH${d + 1})`);
  const chipNames =
    deviceClass === "xbox" ? BTN_NAMES : Array.from({ length: btnCount }, (_, i) => `B${i}`);

  return (
    <div style={{ fontFamily: "system-ui", background: "#222", minHeight: "100vh", color: "#eee" }}>
      <h2 style={{ margin: 0, padding: "10px 12px" }}>Ground Station — ELRS bridge + FC tuning</h2>
      {status && (
        <StatusBar
          tx={status.tx}
          fc={status.fc}
          bridgeHz={status.bridgeHz}
          link={status.link}
          armed={armed}
          corrupt={status.corrupt}
          txUp={status.txUp}
          txDown={status.txDown}
        />
      )}
      <div style={{ padding: 12, display: "grid", gap: 12 }}>
        <section style={{ background: "#2b2b2b", padding: 10, borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>
            {classLabel}{" "}
            <span style={{ fontSize: 12, color: "#bbb" }}>
              ({deviceClass === "rc" ? "EdgeTX-mapping: sticks + schakelaars" : "Xbox-mapping"})
            </span>{" "}
            {linked ? (
              <span style={{ color: "#2ecc71", fontWeight: "bold", fontSize: 14 }}>
                ● LINKED (TX↔RX LQ {status?.link?.uplinkLq}%/{status?.link?.downlinkLq}%)
              </span>
            ) : (
              <span style={{ color: "#777", fontWeight: "bold", fontSize: 14 }}>○ GEEN LINK (TX↔RX)</span>
            )}{" "}
            <span style={{ color: padLive ? "#2ecc71" : "#e74c3c", fontSize: 13 }}>
              {padLive ? `● gevonden: ${padName}` : "○ geen pad zichtbaar voor de browser"}
            </span>{" "}
            <span style={{ fontSize: 12, color: "#bbb" }}>
              {streaming ? "(streamt naar backend)" : wsOpen ? "(verbonden, bridge gestopt)" : "(geen backend-verbinding)"}
            </span>
            {stale && (
              <span style={{ fontSize: 12, color: "#e74c3c", fontWeight: "bold" }}>
                ⚠ INPUT STALE ({staleMs} ms) — laatste stand wordt herhaald, link valt weg bij 5 s
              </span>
            )}
            {tabHidden && run && (
              <span style={{ fontSize: 12, color: "#f39c12", fontWeight: "bold" }}>
                ⚠ tab inactief — input loopt op ~1 Hz, houd deze tab in beeld tijdens vliegen/tunen
              </span>
            )}
          </h3>
          {(pads ?? []).length > 1 && (
            <div style={{ fontSize: 12, color: "#bbb" }}>
              Meerdere pads gevonden, eerste wordt gebruikt:
              <ul>
                {(pads ?? []).map((p) => (
                  <li key={p.index}>
                    [{p.index}] {p.id} (mapping: {p.mapping || "onbekend"}, {p.axes} assen, {p.buttons} knoppen)
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!padLive && (
            <div style={{ fontSize: 12, background: "#3a2b00", padding: 8, borderRadius: 6, marginBottom: 8 }}>
              Browser ziet geen controller. Check in volgorde:
              <ol style={{ margin: "4px 0" }}>
                <li>
                  Xbox-knop indrukken tot hij <strong>continu brandt</strong> (knipperen = niet verbonden).
                </li>
                <li>
                  Windows-toets + <code>joy.cpl</code> → staat hij daar? Nee → USB-kabel/Bluetooth opnieuw koppelen.
                </li>
                <li>
                  Ja in joy.cpl maar niet hier → <strong>Steam Input</strong> kaapt hem: Steam volledig afsluiten
                  (tray → Exit) of Steam → Instellingen → Controller → Xbox-ondersteuning uit, pad daarna uit/aan.
                </li>
                <li>
                  Onafhankelijk testen: <code>gamepad-tester.com</code> — ziet die site hem wel, dan ligt het aan deze
                  pagina (laat weten); ziet die hem ook niet, dan ligt het aan Windows/Steam.
                </li>
              </ol>
            </div>
          )}
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", fontSize: 13 }}>
            <button onClick={() => setRun((v) => !v)}>{run ? "stop bridge" : "start bridge"}</button>
            <label title="Bench-modus zonder controller: stuurt continu vaste kanalen (sticks midden). Negeert de controller.">
              <input type="checkbox" checked={manualOn} onChange={(e) => setManualOn(e.target.checked)} /> handmatig
              (bench)
            </label>
            {manualOn && (
              <label>
                thr {Math.min(10, manualThr).toFixed(0)}% (max 10)
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={0.5}
                  value={Math.min(10, manualThr)}
                  onChange={(e) => setManualThr(Number(e.target.value))}
                />
              </label>
            )}
            {deviceClass !== "rc" && (
              <label>
                throttle-preset{" "}
                <select value={cfg.preset} onChange={(e) => setCfg({ preset: e.target.value as "mode2" | "triggers" })}>
                  <option value="mode2">Mode 2 (links: yaw+thr)</option>
                  <option value="triggers">Triggers (RT−LT = thr)</option>
                </select>
              </label>
            )}
            {deviceClass === "rc" && (
              <>
                <label>
                  arm-as{" "}
                  <select
                    value={cfg.armAxis === undefined ? "auto" : String(cfg.armAxis)}
                    onChange={(e) =>
                      setCfg({ armAxis: e.target.value === "auto" ? undefined : Number(e.target.value) })
                    }
                    title="Welk kanaal armt (houd-schakelaar, >0 = armed). Standaard CH9."
                  >
                    <option value="auto">Auto ({autoAxName(8)})</option>
                    <option value="-1">Uit</option>
                    {axIndices.map((i) => (
                      <option key={i} value={i}>
                        A{i} (CH{i + 1}){i === effArmAxis ? " ← actief" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  mode-as{" "}
                  <select
                    value={cfg.modeAxis === undefined ? "auto" : String(cfg.modeAxis)}
                    onChange={(e) =>
                      setCfg({ modeAxis: e.target.value === "auto" ? undefined : Number(e.target.value) })
                    }
                    title="Welk kanaal Angle/Rate omzet (houd-schakelaar, >0 = Rate). Standaard CH5."
                  >
                    <option value="auto">Auto ({autoAxName(4)})</option>
                    <option value="-1">Uit</option>
                    {axIndices.map((i) => (
                      <option key={i} value={i}>
                        A{i} (CH{i + 1}){i === effModeAxis ? " ← actief" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <label>
              arm-knop{" "}
              <select
                value={cfg.armButton === undefined ? "auto" : String(cfg.armButton)}
                onChange={(e) =>
                  setCfg({ armButton: e.target.value === "auto" ? undefined : Number(e.target.value) })
                }
                title="Welke knop/schakelaar armt. Expliciete keuze wint van de arm-as. Zet een schakelaar om en kijk welke chip oplicht."
              >
                <option value="auto">Auto ({autoName(5)})</option>
                <option value="-1">Uit</option>
                {btnIndices.map((i) => (
                  <option key={i} value={i}>
                    B{i}
                    {deviceClass === "xbox" && BTN_NAMES[i] ? ` (${BTN_NAMES[i]})` : ""}
                    {i === effArm ? " ← actief" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              mode-knop{" "}
              <select
                value={cfg.modeButton === undefined ? "auto" : String(cfg.modeButton)}
                onChange={(e) =>
                  setCfg({ modeButton: e.target.value === "auto" ? undefined : Number(e.target.value) })
                }
                title="Welke knop/schakelaar Angle/Rate omzet (toggle)."
              >
                <option value="auto">Auto ({autoName(4)})</option>
                <option value="-1">Uit</option>
                {btnIndices.map((i) => (
                  <option key={i} value={i}>
                    B{i}
                    {deviceClass === "xbox" && BTN_NAMES[i] ? ` (${BTN_NAMES[i]})` : ""}
                    {i === effMode ? " ← actief" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              expo {cfg.expo.toFixed(2)}{" "}
              <input
                type="range"
                min={0}
                max={0.9}
                step={0.05}
                value={cfg.expo}
                onChange={(e) => setCfg({ expo: Number(e.target.value) })}
              />
            </label>
            <label>
              <input type="checkbox" checked={manualArm} onChange={(e) => setManualArm(e.target.checked)} /> arm
              handmatig
            </label>
            <label>
              <input type="checkbox" checked={manualMode} onChange={(e) => setManualMode(e.target.checked)} /> rate
              handmatig
            </label>
            {armed ? (
              <span style={{ color: "#e74c3c", fontWeight: "bold" }}>
                ARMED
                {deviceClass !== "rc" && latchedArm && (
                  <button onClick={() => setLatchedArm(false)} style={{ marginLeft: 6 }}>
                    uit (Back)
                  </button>
                )}
              </span>
            ) : (
              <span style={{ color: "#2ecc71", fontWeight: "bold" }}>DISARMED</span>
            )}
            <span style={{ color: rate ? "#f39c12" : "#2ecc71", fontWeight: "bold" }}>
              {rate ? "RATE" : "ANGLE"}
            </span>
          </div>
          <div style={{ display: "flex", gap: 4, marginTop: 8, flexWrap: "wrap" }}>
            {chipNames.map((n, i) => (
              <span
                key={n}
                title={n}
                style={{
                  fontSize: 11,
                  padding: "2px 6px",
                  borderRadius: 4,
                  background: padButtons[i] ? "#2ecc71" : "#444",
                  color: "#fff",
                }}
              >
                {n}
              </span>
            ))}
          </div>
          {raw && (
            <div style={{ fontSize: 11, color: "#bbb", fontFamily: "monospace", marginTop: 6 }}>
              raw assen ({raw.axes.length}): [{raw.axes.join(", ")}] — knoppen aan: [
              {raw.btns.join(", ") || "—"}]
            </div>
          )}
          {deviceClass === "rc" && effArmAxis >= 0 && (pads[0]?.axes ?? 0) <= effArmAxis && (
            <div style={{ fontSize: 12, background: "#3a2b00", padding: 8, borderRadius: 6, marginTop: 6 }}>
              Arm-as A{effArmAxis} (CH{effArmAxis + 1}) komt niet binnen — de browser meldt maar{" "}
              {pads[0]?.axes} assen. Zet in EdgeTX (USB-joystick) meer kanalen aan, of wijs de arm-schakelaar
              toe via de arm-knop-select (kijk welke chip oplicht bij omzetten).
            </div>
          )}
          <details style={{ fontSize: 12, color: "#bbb", marginTop: 8 }}>
            <summary>Knop-mapping</summary>
            <ul>
              {legend.map(([k, v]) => (
                <li key={k}>
                  <strong>{k}</strong>: {v}
                </li>
              ))}
            </ul>
          </details>
        </section>
        <section style={{ background: "#2b2b2b", padding: 10, borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Kanalenmonitor (EdgeTX-stijl)</h3>
          <ChannelMonitor channels={channels} />
          {!status?.tx.open && (
            <button onClick={() => reconnect("tx")} style={{ marginTop: 8 }}>
              reconnect TX
            </button>
          )}
          {!status?.fc.open && status && (
            <button onClick={() => reconnect("fc")} style={{ marginTop: 8, marginLeft: 8 }}>
              reconnect FC
            </button>
          )}
        </section>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <section style={{ background: "#2b2b2b", padding: 10, borderRadius: 8 }}>
            <h3 style={{ marginTop: 0 }}>Horizon</h3>
            {status && <Horizon roll={status.attitude.roll} pitch={status.attitude.pitch} yaw={status.attitude.yaw} />}
          </section>
          <section style={{ background: "#2b2b2b", padding: 10, borderRadius: 8, flex: 1, minWidth: 300 }}>
            <h3 style={{ marginTop: 0 }}>Tuning (postcard)</h3>
            <Tuning fcSupported={status?.fcSupported ?? false} sendFc={sendFc} />
          </section>
        </div>
        <section style={{ background: "#2b2b2b", padding: 10, borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Log</h3>
          <LogWindow logs={log} level={level} setLevel={setLevel} />
        </section>
      </div>
    </div>
  );
}
