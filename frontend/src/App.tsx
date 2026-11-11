import { useEffect, useState } from "react";
import { useXboxBridge, useXboxConfigState } from "./hooks";
import { BaudSelect, ChannelMonitor, Horizon, Icon, LogWindow, PATHS, StatusBar, ToastStack } from "./components/widgets";
import { Tuning } from "./components/Tuning";
import { RxPanel } from "./components/RxPanel";
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
  const [thrStep, setThrStep] = useState<1 | 0.5 | 0.2>(1);
  const bumpThr = (d: number) => setManualThr((v) => Math.min(10, Math.max(0, Math.round((v + d) * 100) / 100)));
  const [tabHidden, setTabHidden] = useState(
    typeof document !== "undefined" ? document.hidden : false,
  );
  useEffect(() => {
    const onVis = () => setTabHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  const [level, setLevel] = useState<LogLevel>("info");
  const { padName, padLive, pads, deviceClass, effArm, effMode, effArmAxis, effModeAxis, wsOpen, connState, retryCount, retryNow, streaming, padButtons, raw, latchedArm, setLatchedArm, log, toasts, dismissToast, rx, clearRx, status, setTxBaud, sendFc, sendTune, reconnect } = useXboxBridge(
    WS_URL,
    cfg,
    run,
    manualArm,
    manualMode,
    manualOn,
    manualThr,
  );
  const channels = status?.channels ?? new Array(16).fill(992);
  const staleMs = status?.inputAgeMs ?? null;
  const stale = staleMs !== null && staleMs > 500;
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
  const rDeg = status ? ((status.attitude.roll * 180) / Math.PI).toFixed(1) : "0.0";
  const pDeg = status ? ((status.attitude.pitch * 180) / Math.PI).toFixed(1) : "0.0";
  const yDeg = status ? ((status.attitude.yaw * 180) / Math.PI).toFixed(1) : "0.0";
  const pingFresh = status?.lastPingAt != null && Date.now() - status.lastPingAt < 3000;

  return (
    <div className="gs-root">
      <header className="gs-header">
        <div className="gs-brand">
          <span className="gs-brand-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 2v4m0 12v4M2 12h4m12 0h4M5 5l2.5 2.5M16.5 16.5 19 19M19 5l-2.5 2.5M7.5 16.5 5 19"
                stroke="#fff"
                strokeWidth={2}
                strokeLinecap="round"
              />
              <circle cx="12" cy="12" r="3" fill="#fff" />
            </svg>
          </span>
          <h1>
            Ground Station
            <small>ELRS bridge + FC tuning</small>
          </h1>
        </div>
        <div className="gs-header-status">
          {linked ? (
            <span className="pill pill--ok">
              <span className="dot" /> LINK {status?.link?.uplinkLq}%/{status?.link?.downlinkLq}%
            </span>
          ) : (
            <span className="pill pill--bad">
              <span className="dot" /> GEEN LINK
            </span>
          )}
          <span
            className={`pill ${armed ? "pill--armed" : "pill--ok"}`}
            role="status"
            aria-live="polite"
            aria-label={armed ? "Systeem is armed" : "Systeem is disarmed"}
          >
            {armed ? "ARMED" : "DISARMED"}
          </span>
          <span className={`pill ${rate ? "pill--rate" : "pill--angle"}`}>{rate ? "RATE" : "ANGLE"}</span>
          <span className={`pill ${streaming ? "pill--info" : ""}`} title={wsOpen ? "Verbonden met backend" : "Geen backend-verbinding"}>
            <span className="dot" style={{ background: streaming ? "var(--accent)" : wsOpen ? "var(--warn)" : "var(--danger)" }} />
            {streaming ? `streamt · ${status?.bridgeHz ?? 0}Hz` : wsOpen ? "bridge gestopt" : "geen backend"}
          </span>
          <span
            className={`pill pill--rtt ${pingFresh ? "pill--info" : ""}`}
            title="ELRS-heartbeat PC → TX → lucht → RX → FC → retour (1Hz zodra TX open is)"
          >
            <span className="dot" style={{ background: pingFresh ? "var(--accent)" : "var(--faint)" }} />
            <span className="pill__rtt">{pingFresh ? `RTT ${status?.lastPingMs}ms` : "RTT —"}</span>
          </span>
          <button
            className={`btn btn--primary${run ? " is-live" : ""}`}
            onClick={() => setRun((v) => !v)}
            aria-pressed={run}
          >
            {run ? "Stop bridge" : "Start bridge"}
          </button>
        </div>
      </header>

      <main className="gs-main">
        {connState !== "open" && (
          <div className={`conn-banner alert ${connState === "down" ? "alert--error" : "alert--info"}`} role="alert">
            <Icon d={connState === "down" ? PATHS.error : PATHS.info} color={connState === "down" ? "var(--danger)" : "var(--accent)"} />
            <div>
              {connState === "down" ? (
                <>
                  <strong>Geen verbinding met de backend</strong> <span className="mono">{WS_URL}</span>
                  {retryCount > 0 && <span> (poging {retryCount}, elke 3 s)</span>} — draait de bridge
                  nog? Check het terminalvenster (EADDRINUSE = oude bridge killen).
                  <div style={{ marginTop: 6 }}>
                    <button className="btn btn--small" onClick={retryNow}>
                      Opnieuw verbinden
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <strong>Verbinden met de backend</strong> <span className="mono">{WS_URL}</span> …
                </>
              )}
            </div>
          </div>
        )}
        <ToastStack toasts={toasts} onDismiss={dismissToast} />        {(stale || (tabHidden && run) || !padLive) && (
          <div className="gs-grid">
            <div className="span-12" style={{ display: "grid", gap: 8 }}>
              {stale && (
                <div className="alert alert--error" role="alert">
                  <Icon d={PATHS.warn} color="var(--danger)" />
                  <div>
                    <strong>Input verouderd ({staleMs} ms).</strong> Laatste stand wordt herhaald — link valt weg bij 5 s zonder verse input.
                  </div>
                </div>
              )}
              {tabHidden && run && (
                <div className="alert alert--warn" role="alert">
                  <Icon d={PATHS.warn} color="var(--warn)" />
                  <div>
                    <strong>Tab inactief.</strong> Browsers throttlen gamepad-input naar ~1 Hz op de achtergrond — houd deze tab in beeld tijdens vliegen/tunen.
                  </div>
                </div>
              )}
              {!padLive && (
                <div className="alert alert--info">
                  <Icon d={PATHS.info} color="var(--accent)" />
                  <div>
                    <strong>Browser ziet geen controller.</strong> Check in volgorde:
                    <ol className="help-list">
                      <li>Xbox-knop indrukken tot hij <strong>continu brandt</strong> (knipperen = niet verbonden).</li>
                      <li>Windows-toets + <code>joy.cpl</code> → staat hij daar? Zo niet: USB-kabel/Bluetooth opnieuw koppelen.</li>
                      <li>Staat hij wel in joy.cpl maar niet hier → <strong>Steam Input</strong> kaapt hem: Steam volledig afsluiten (tray → Exit) of Xbox-ondersteuning uitzetten, pad daarna uit/aan.</li>
                      <li>Onafhankelijk testen: <code>gamepad-tester.com</code> — ziet die site hem wel, dan ligt het aan deze pagina; ziet die hem ook niet, dan ligt het aan Windows/Steam.</li>
                    </ol>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {status && <StatusBar tx={status.tx} fc={status.fc} bridgeHz={status.bridgeHz} link={status.link} armed={armed} corrupt={status.corrupt} txUp={status.txUp} txDown={status.txDown} pingRttMs={pingFresh ? (status.lastPingMs ?? null) : null} />}

        <div className="gs-grid">
          <section className="card span-12 section-anchor" aria-label="Ontvangst">
            <div className="card__head">
              <h2 className="card__title">Ontvangst</h2>
              <span className="card__sub">alles wat TX- en FC-poort terugsturen — geldig én fouten, met ruwe bytes</span>
            </div>
            <div className="card__body">
              <RxPanel sights={rx} onClear={clearRx} />
            </div>
          </section>
        </div>

        {(!status?.tx.open || (status && !status.fc.open)) && status && (
          <div className="controls">
            {!status.tx.open && (
              <button className="btn btn--small" onClick={() => reconnect("tx")}>
                Reconnect TX
              </button>
            )}
            {!status.fc.open && (
              <button className="btn btn--small" onClick={() => reconnect("fc")}>
                Reconnect FC
              </button>
            )}
          </div>
        )}

        <div className="controls">
          <BaudSelect activeBaud={status?.tx.baud ?? null} onApply={setTxBaud} />
        </div>

        <div className="gs-grid">
          <section className="card span-5 section-anchor" aria-label="Controller-input">
            <div className="card__head">
              <h2 className="card__title">Controller</h2>
              <span className="card__sub">
                {classLabel} · {deviceClass === "rc" ? "EdgeTX-mapping: sticks + schakelaars" : "Xbox-mapping"}
              </span>
            </div>
            <div className="card__body">
              <div className="controls">
                <span className={`pill ${padLive ? "pill--ok" : "pill--bad"}`}>
                  <span className="dot" /> {padLive ? padName : "geen pad gevonden"}
                </span>
              </div>

              {(pads ?? []).length > 1 && (
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  Meerdere pads gevonden, eerste wordt gebruikt:
                  <ul className="pad-list">
                    {(pads ?? []).map((p) => (
                      <li key={p.index}>
                        [{p.index}] {p.id} (mapping: {p.mapping || "onbekend"}, {p.axes} assen, {p.buttons} knoppen)
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="controls">
                <label className="field field--check" title="Bench-modus zonder controller: stuurt continu vaste kanalen (sticks midden). Negeert de controller.">
                  <input type="checkbox" checked={manualOn} onChange={(e) => setManualOn(e.target.checked)} />
                  <span>Handmatig (bench)</span>
                </label>
                {manualOn && (
                  <>
                    <label className="field">
                      <span className="mono">thr {Math.min(10, manualThr).toFixed(1)}%</span>
                      <input
                        type="range"
                        min={0}
                        max={10}
                        step={0.1}
                        value={Math.min(10, manualThr)}
                        onChange={(e) => setManualThr(Number(e.target.value))}
                        aria-label="Handmatige throttle in procent, maximaal 10"
                      />
                    </label>
                    <span className="stepper">
                      <button className="btn btn--small" onClick={() => bumpThr(-thrStep)} title={`-${thrStep}%`} aria-label={`Throttle min ${thrStep} procent`}>−</button>
                      <button className="btn btn--small" onClick={() => bumpThr(thrStep)} title={`+${thrStep}%`} aria-label={`Throttle plus ${thrStep} procent`}>+</button>
                      <select value={thrStep} onChange={(e) => setThrStep(Number(e.target.value) as 1 | 0.5 | 0.2)} title="stapgrootte" aria-label="Stapgrootte throttle">
                        <option value={1}>1.0</option>
                        <option value={0.5}>0.5</option>
                        <option value={0.2}>0.2</option>
                      </select>
                    </span>
                  </>
                )}
              </div>

              <hr className="divider" />

              <div className="controls">
                {deviceClass !== "rc" && (
                  <label className="field">
                    <span>Throttle-preset</span>
                    <select value={cfg.preset} onChange={(e) => setCfg({ preset: e.target.value as "mode2" | "triggers" })}>
                      <option value="mode2">Mode 2 (links: yaw+thr)</option>
                      <option value="triggers">Triggers (RT−LT = thr)</option>
                    </select>
                  </label>
                )}
                {deviceClass === "rc" && (
                  <>
                    <label className="field">
                      <span>Arm-as</span>
                      <select
                        value={cfg.armAxis === undefined ? "auto" : String(cfg.armAxis)}
                        onChange={(e) => setCfg({ armAxis: e.target.value === "auto" ? undefined : Number(e.target.value) })}
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
                    <label className="field">
                      <span>Mode-as</span>
                      <select
                        value={cfg.modeAxis === undefined ? "auto" : String(cfg.modeAxis)}
                        onChange={(e) => setCfg({ modeAxis: e.target.value === "auto" ? undefined : Number(e.target.value) })}
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
                <label className="field">
                  <span>Arm-knop</span>
                  <select
                    value={cfg.armButton === undefined ? "auto" : String(cfg.armButton)}
                    onChange={(e) => setCfg({ armButton: e.target.value === "auto" ? undefined : Number(e.target.value) })}
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
                <label className="field">
                  <span>Mode-knop</span>
                  <select
                    value={cfg.modeButton === undefined ? "auto" : String(cfg.modeButton)}
                    onChange={(e) => setCfg({ modeButton: e.target.value === "auto" ? undefined : Number(e.target.value) })}
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
              </div>

              <div className="controls">
                <label className="field">
                  <span className="mono">expo {cfg.expo.toFixed(2)}</span>
                  <input
                    type="range"
                    min={0}
                    max={0.9}
                    step={0.05}
                    value={cfg.expo}
                    onChange={(e) => setCfg({ expo: Number(e.target.value) })}
                    aria-label="Expo"
                  />
                </label>
                <label className="field">
                  <span className="mono">deadband {cfg.deadband.toFixed(2)}</span>
                  <input
                    type="range"
                    min={0}
                    max={0.3}
                    step={0.01}
                    value={cfg.deadband}
                    onChange={(e) => setCfg({ deadband: Number(e.target.value) })}
                    aria-label="Deadband"
                  />
                </label>
                <label className="field field--check">
                  <input type="checkbox" checked={manualArm} onChange={(e) => setManualArm(e.target.checked)} />
                  <span>Arm handmatig</span>
                </label>
                <label className="field field--check">
                  <input type="checkbox" checked={manualMode} onChange={(e) => setManualMode(e.target.checked)} />
                  <span>Rate handmatig</span>
                </label>
                {armed && deviceClass !== "rc" && latchedArm && (
                  <button className="btn btn--danger btn--small" onClick={() => setLatchedArm(false)}>
                    Disarm (Back)
                  </button>
                )}
              </div>

              <div className="chips" role="group" aria-label="Pad-knopstatus">
                {chipNames.map((n, i) => (
                  <span
                    key={`${n}-${i}`}
                    title={n}
                    className={`chip${padButtons[i] ? " chip--on" : ""}${!padButtons[i] && (i === effArm || i === effMode) ? " chip--mapped" : ""}`}
                  >
                    {n}
                  </span>
                ))}
              </div>

              {raw && (
                <div className="rawline">
                  assen ({raw.axes.length}): [{raw.axes.join(", ")}] — aan: [{raw.btns.join(", ") || "—"}]
                </div>
              )}

              {deviceClass === "rc" && effArmAxis >= 0 && (pads[0]?.axes ?? 0) <= effArmAxis && (
                <div className="alert alert--warn">
                  <Icon d={PATHS.warn} color="var(--warn)" />
                  <div>
                    Arm-as A{effArmAxis} (CH{effArmAxis + 1}) komt niet binnen — de browser meldt maar{" "}
                    {pads[0]?.axes} assen. Zet in EdgeTX (USB-joystick) meer kanalen aan, of wijs de arm-schakelaar
                    toe via de arm-knop-select (kijk welke chip oplicht bij omzetten).
                  </div>
                </div>
              )}

              <details className="gs-details">
                <summary>Knop-mapping</summary>
                <ul>
                  {legend.map(([k, v]) => (
                    <li key={k}>
                      <strong>{k}</strong>: {v}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          </section>

          <section className="card span-7 section-anchor" aria-label="Kanaalmonitor">
            <div className="card__head">
              <h2 className="card__title">Kanalen</h2>
              <span className="card__sub">EdgeTX-stijl · 172–1811 · live uit verstuurde input</span>
            </div>
            <div className="card__body">
              <ChannelMonitor channels={channels} />
            </div>
          </section>

          <section className="card span-4 section-anchor" aria-label="Houding">
            <div className="card__head">
              <h2 className="card__title">Houding</h2>
              <span className="card__sub">FC-telemetrie</span>
            </div>
            <div className="card__body">
              <div className="horizon-wrap">
                {status && <Horizon roll={status.attitude.roll} pitch={status.attitude.pitch} yaw={status.attitude.yaw} />}
                <dl className="attitude" style={{ margin: 0 }}>
                  <div className="kv"><dt>Rol</dt><dd>{rDeg}°</dd></div>
                  <div className="kv"><dt>Pitch</dt><dd>{pDeg}°</dd></div>
                  <div className="kv"><dt>Yaw</dt><dd>{yDeg}°</dd></div>
                  <div className="kv">
                    <dt>Link</dt>
                    <dd>{status?.link ? `${status.link.uplinkLq}% / ${status.link.downlinkLq}%` : "—"}</dd>
                  </div>
                </dl>
              </div>
            </div>
          </section>

          <section className="card span-4 section-anchor" aria-label="PID-tuning">
            <div className="card__head">
              <h2 className="card__title">Tuning</h2>
              <span className="card__sub">postcard · live via ELRS</span>
            </div>
            <div className="card__body">
              <Tuning fcSupported={status?.fcSupported ?? false} sendFc={sendFc} sendTune={sendTune} lastAck={status?.lastTunack ?? null} />
            </div>
          </section>

          <section className="card span-4 section-anchor" aria-label="Logboek">
            <div className="card__head">
              <h2 className="card__title">Log</h2>
              <span className="card__sub">{log.length} regels</span>
            </div>
            <div className="card__body">
              <LogWindow logs={log} level={level} setLevel={setLevel} />
            </div>
          </section>
        </div>

        <footer className="gs-footer">
          Ground Station · bridge {status?.bridgeHz ?? 0} Hz · backend {WS_URL}
        </footer>
      </main>
    </div>
  );
}
