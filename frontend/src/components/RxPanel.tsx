import { useEffect, useRef, useState } from "react";
import type { RxSight, RxSightKind } from "@ground-station/shared";
import { Icon, PATHS } from "./widgets";

function fmtTime(at: number): string {
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

const hex = (bytes: number[]): string =>
  bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");

const KIND_ORDER: RxSightKind[] = ["link", "ping", "tunack", "radio", "fc", "other", "error"];
const KIND_LABEL: Record<RxSightKind, string> = {
  link: "Link-stats",
  ping: "Ping",
  tunack: "TuneAck",
  radio: "Radio-ID/timing",
  fc: "FC (USB)",
  other: "Overig",
  error: "Fouten",
};
// 0x3A (radio-ID/handset-timing) en 0x14 link-stats zijn normaal maar frequent;
// standaard uit. Ping/TuneAck/FC/overig/fouten blijven zichtbaar.
const DEFAULT_VISIBLE: RxSightKind[] = ["ping", "tunack", "fc", "other", "error"];

/** RX-inspector: alles wat de backend op TX- en FC-poort terugziet, incl. fouten. */
export function RxPanel(props: { sights: RxSight[]; onClear: () => void }) {
  const [port, setPort] = useState<"alle" | "tx" | "fc">("alle");
  const [visible, setVisible] = useState<Set<RxSightKind>>(() => new Set(DEFAULT_VISIBLE));
  const [paused, setPaused] = useState(false);
  const frozen = useRef<RxSight[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [stick, setStick] = useState(true);
  useEffect(() => {
    if (!paused) frozen.current = props.sights;
  }, [paused, props.sights]);
  const live = paused ? frozen.current : props.sights;

  const inPort = live.filter((s) => (port === "alle" ? true : s.port === port));
  const counts = Object.fromEntries(KIND_ORDER.map((k) => [k, 0])) as Record<RxSightKind, number>;
  for (const s of inPort) counts[s.kind] += 1;

  const rows = inPort.filter((s) => visible.has(s.kind));
  const matching = rows.length;
  const newestId = rows.length > 0 ? rows[rows.length - 1]!.id : 0;

  // Nieuwe events: alleen naar beneden scrollen als de gebruiker onderaan staat.
  // Zo kun je omhoog scrollen zonder dat elk event je terugtrekt.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [newestId, rows.length]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stickRef.current = atBottom;
    setStick(atBottom);
  };
  const jumpToNewest = () => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setStick(true);
  };

  const toggle = (k: RxSightKind) =>
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const setAll = (on: boolean) => setVisible(new Set(on ? KIND_ORDER : []));

  return (
    <div className="rx">
      <div className="rx__filters">
        <div role="group" aria-label="Poortfilter" style={{ display: "inline-flex", gap: 6 }}>
          {(["alle", "tx", "fc"] as const).map((p) => (
            <button
              key={p}
              className={`btn btn--small btn--ghost${port === p ? " is-active" : ""}`}
              aria-pressed={port === p}
              onClick={() => setPort(p)}
            >
              {p === "alle" ? "Alle" : p.toUpperCase()}
            </button>
          ))}
        </div>

        <details className="rx__filter">
          <summary
            className="btn btn--small btn--ghost"
            title="Filter berichttypes"
            aria-label={`Filter berichttypes (${visible.size} van ${KIND_ORDER.length} zichtbaar)`}
          >
            <Icon d={PATHS.filter} />
            <span className="rx__filter-badge mono">
              {visible.size}/{KIND_ORDER.length}
            </span>
          </summary>
          <div className="rx__filter-pop" role="group" aria-label="Berichttypefilter">
            <div className="rx__filter-head">
              <strong>Berichttypes</strong>
              <button type="button" className="btn btn--small btn--ghost" onClick={() => setAll(true)}>
                Alles
              </button>
              <button type="button" className="btn btn--small btn--ghost" onClick={() => setAll(false)}>
                Niets
              </button>
            </div>
            {KIND_ORDER.map((k) => (
              <label key={k} className="rx__filter-row">
                <input type="checkbox" checked={visible.has(k)} onChange={() => toggle(k)} />
                <span className="rx__filter-label">{KIND_LABEL[k]}</span>
                <span className="rx__filter-count mono">{counts[k]}</span>
              </label>
            ))}
          </div>
        </details>

        <span style={{ flex: 1 }} aria-hidden="true" />
        <span className="mono" style={{ fontSize: 12, color: "var(--faint)" }}>
          {matching}/{live.length} events{paused ? " · gepauzeerd" : ""}
        </span>
        {!stick && (
          <button className="btn btn--small btn--ghost" onClick={jumpToNewest} title="Naar de nieuwste events">
            ↓ Nieuwste
          </button>
        )}
        <button className="btn btn--small btn--ghost" onClick={() => setPaused((v) => !v)} aria-pressed={paused}>
          {paused ? "Hervat" : "Pauzeer"}
        </button>
        <button className="btn btn--small btn--ghost" onClick={props.onClear}>
          Wissen
        </button>
      </div>
      <div className="rx__body" role="log" aria-label="Ontvangen berichten" ref={bodyRef} onScroll={onScroll}>
        {rows.length === 0 && (
          <div className="rx__empty">
            {visible.size === 0 ? "— geen berichttypes geselecteerd —" : "— nog niets ontvangen —"}
          </div>
        )}
        {rows.map((s) => (
          <div key={s.id} className={`rx__row${s.ok ? "" : " rx__row--bad"}`}>
            <span className="rx__time mono">{fmtTime(s.at)}</span>
            <span className={`rx__port rx__port--${s.port}`}>{s.port.toUpperCase()}</span>
            <span className={`rx__dot${s.ok ? "" : " rx__dot--bad"}`} aria-hidden="true" />
            <span className="rx__main">
              <span className="rx__label">{s.label}</span>
              {s.note && <span className="rx__note">{s.note}</span>}
              {s.bytes.length > 0 && <span className="rx__hex mono">{hex(s.bytes)}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
