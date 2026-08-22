"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./incident-reports.module.css";
import { CameraIcon, EmptyImage, MapIcon } from "./icons";
import { getRoster } from "@/lib/cameras";
import {
  getIncidents,
  incidentAsset,
  isWorking,
  openIncident,
  type AnalystInfo,
  type Incident,
  type Severity,
} from "@/lib/incidents";

/** Nothing being written means nothing is going to change for a while. */
const IDLE_INTERVAL_MS = 6_000;
const WORKING_INTERVAL_MS = 2_000;
const ROSTER_INTERVAL_MS = 5_000;

/** What each severity is worth reading as, at a glance, in a list of twenty. */
const SEVERITY_RANK: Record<Severity, string> = {
  clear: "Clear",
  low: "Low",
  moderate: "Moderate",
  high: "High",
  critical: "Critical",
};

/**
 * What the drones have found, written up.
 *
 * <p>This is where a photograph ends up. The drone is already filming, so a report costs a copy
 * of the frame it was on: those photographs go to the n8n workflow, which captions them and
 * generates its view of the scene, and the caption is handed to the analyst along with what the
 * live feed says is burning around that drone. The three plates - the photograph, the generated
 * view and the map of the affected area - are the evidence, and the prose underneath is the
 * reading of it.
 *
 * <p>A report is on screen from the moment its photographs are taken, minutes before the rest
 * of it lands, because the picture is the part somebody is waiting for.
 */
export default function IncidentReports({ active, request }: {
  active: boolean;
  /** A report a camera feed just opened, handed over so it is the one on screen. */
  request: { id: string } | null;
}) {
  const { incidents, analyst, offline, refresh } = useIncidents(active);
  const [chosenId, setChosenId] = useState<string | null>(null);

  // Newest by default, and the newest keeps the screen until somebody picks another - a report
  // being written is exactly the one worth watching fill in.
  const openId = chosenId ?? incidents[0]?.id ?? null;
  const open = incidents.find((incident) => incident.id === openId) ?? null;

  useEffect(() => {
    if (request) setChosenId(request.id);
  }, [request]);

  // A report that has fallen off the end of the roster takes the panel with it.
  useEffect(() => {
    if (chosenId && !incidents.some((incident) => incident.id === chosenId)) setChosenId(null);
  }, [chosenId, incidents]);

  return (
    <div className={styles.workspace}>
      <div className={styles.bar}>
        <Status analyst={analyst} offline={offline} incidents={incidents} />
        <NewReport active={active} onOpened={(id) => { setChosenId(id); refresh(); }} />
      </div>

      <div className={styles.split}>
        <ol className={styles.list} aria-label="Incident reports">
          {incidents.map((incident) => (
            <li key={incident.id}>
              <button
                type="button"
                className={styles.entry}
                data-active={incident.id === openId}
                data-severity={incident.report?.severity ?? "pending"}
                onClick={() => setChosenId(incident.id)}
              >
                <span className={styles.entryTop}>
                  <b>{incident.report?.severity ?? incident.status}</b>
                  <time dateTime={incident.created}>{ago(incident.created)}</time>
                </span>
                <span className={styles.entryHeadline}>
                  {incident.report?.headline ?? `${incident.drone_id} - writing up ${incident.shots} photo(s)`}
                </span>
                <span className={styles.entryFoot}>
                  <CameraIcon />
                  {incident.drone_id}
                  {incident.scene.position && (
                    <em>{Math.round(incident.scene.position.x)}, {Math.round(incident.scene.position.z)}</em>
                  )}
                </span>
              </button>
            </li>
          ))}
          {incidents.length === 0 && (
            <li className={styles.notice}>
              {offline
                ? "No capture server on /backend - start python/server.py."
                : "No reports yet. Pick a drone above and have it photograph what it can see."}
            </li>
          )}
        </ol>

        {open ? <Report incident={open} /> : <div className={styles.blank} />}
      </div>
    </div>
  );
}

/** Where the pipeline stands: how many are still being written, and who is writing them. */
function Status({ analyst, offline, incidents }: {
  analyst: AnalystInfo | null;
  offline: boolean;
  incidents: Incident[];
}) {
  const working = incidents.filter(isWorking).length;
  return (
    <p className={styles.status}>
      <span data-live={!offline} />
      {offline
        ? "waiting for the capture server"
        : analyst?.available
          ? `n8n captions the photo, ${analyst.model} writes it up`
          : "n8n captions the photo - no analyst key, so reports are the numbers only"}
      {working > 0 && <em>{working} being written</em>}
    </p>
  );
}

/** Send a drone to photograph what it is looking at, the same way a workflow would. */
function NewReport({ active, onOpened }: { active: boolean; onOpened: (id: string) => void }) {
  const drones = useDrones(active);
  const [chosen, setChosen] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follow the roster until somebody picks a drone, so the button always has a subject.
  const using = chosen && drones.includes(chosen) ? chosen : drones[0] ?? "";

  const take = async () => {
    if (!using) return;
    setBusy(true);
    setError(null);
    try {
      const { incident } = await openIncident({ droneId: using, note: note.trim() });
      setNote("");
      onOpened(incident.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "could not photograph that drone");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.new}>
      {error && <span className={styles.error}>{error}</span>}
      <input
        className={styles.note}
        type="text"
        value={note}
        placeholder="What to look at (optional)"
        onChange={(event) => setNote(event.target.value)}
      />
      <label className={styles.pick}>
        <span className="sr-only">Drone to photograph with</span>
        <select value={using} disabled={drones.length === 0} onChange={(event) => setChosen(event.target.value)}>
          {drones.map((id) => <option key={id} value={id}>{id}</option>)}
          {drones.length === 0 && <option value="">no drones in the air</option>}
        </select>
      </label>
      <button type="button" disabled={busy || !using} onClick={() => void take()}>
        <CameraIcon />
        <span>{busy ? "Photographing" : "Photograph & report"}</span>
      </button>
    </div>
  );
}

/** One report: the plates, then the reading of them. */
function Report({ incident }: { incident: Incident }) {
  const report = incident.report;
  const { scene, map_meta: map } = incident;

  return (
    <article className={styles.report}>
      <header className={styles.head}>
        <h2>{report?.headline ?? `${incident.drone_id} - report being written`}</h2>
        <div className={styles.tags}>
          <span className={styles.severity} data-severity={report?.severity ?? "pending"}>
            {report ? SEVERITY_RANK[report.severity] ?? report.severity : "Pending"}
          </span>
          <span>{incident.drone_id}</span>
          {scene.position && (
            <span>
              {Math.round(scene.position.x)}, {Math.round(scene.position.y)}, {Math.round(scene.position.z)}
            </span>
          )}
          <time dateTime={incident.created}>{stamp(incident.created)}</time>
          {report && (
            <span className={styles.by}>
              {report.source === "ai" ? report.model : "no analyst - numbers only"}
              {report.confidence && report.source === "ai" && ` · ${report.confidence} confidence`}
            </span>
          )}
        </div>
        <Progress incident={incident} />
      </header>

      <div className={styles.plates}>
        <Imagery incident={incident} />
        <figure className={styles.plate}>
          <div className={styles.plateImage}>
            {incident.map
              ? <img src={incidentAsset(incident.id, incident.map)} alt={`map of the area around ${incident.drone_id}`} />
              : <EmptyImage ratio label={scene.position ? "Map not drawn" : "The feed does not say where this drone is"} />}
          </div>
          <figcaption>
            <span className={styles.plateTitle}><MapIcon />Affected area</span>
            {map && (
              <span className={styles.plateMeta}>
                {map.width}×{map.height} blocks around {Math.round(map.center.x)}, {Math.round(map.center.z)}
                {!map.terrain && " · terrain unseen by the feed"}
              </span>
            )}
            <span className={styles.legend}>
              <i data-mark="drone" />drone
              <i data-mark="fire" />burning
              <i data-mark="event" />event radius
            </span>
          </figcaption>
        </figure>
      </div>

      {report && (
        <div className={styles.prose}>
          <p className={styles.summary}>{report.summary}</p>
          <dl className={styles.findings}>
            <div><dt>What the camera saw</dt><dd>{report.scene}</dd></div>
            <div><dt>Spread</dt><dd>{report.spread}</dd></div>
            <div><dt>Impact</dt><dd>{report.impact}</dd></div>
          </dl>
          {report.actions.length > 0 && (
            <div className={styles.actions}>
              <h3>Recommended</h3>
              <ol>{report.actions.map((action, index) => <li key={index}>{action}</li>)}</ol>
            </div>
          )}
          {report.error && <p className={styles.warn}>The analyst was not reached: {report.error}</p>}
        </div>
      )}

      <Readings incident={incident} />
    </article>
  );
}

/** The photograph, and the picture n8n made of it, one plate with two faces. */
function Imagery({ incident }: { incident: Incident }) {
  const faces = useMemo(() => {
    // The caption belongs to the first photograph - that is the one that went up - and it is
    // worth showing there rather than only on the generated view, because it arrives about five
    // minutes earlier and it is what the write-up was built from.
    const shots = incident.photos.map((file, index) => ({
      key: file,
      label: incident.photos.length > 1 ? `Photo ${index + 1}` : "Photograph",
      file,
      note: (index === 0 ? incident.generated_prompt : null) as string | null,
    }));
    // The generated view is a separate face rather than a separate plate: it is the same scene,
    // and putting them side by side invites reading the generated one as evidence.
    if (incident.generated && incident.generated !== incident.photos[0]) {
      shots.push({
        key: "generated",
        label: "Generated",
        file: incident.generated,
        note: incident.generated_prompt ?? incident.caption,
      });
    }
    return shots;
  }, [incident.photos, incident.generated, incident.generated_prompt, incident.caption]);

  const [face, setFace] = useState(0);
  useEffect(() => setFace(0), [incident.id]);
  const showing = faces[Math.min(face, faces.length - 1)];

  return (
    <figure className={styles.plate}>
      <div className={styles.plateImage}>
        {showing
          ? <img src={incidentAsset(incident.id, showing.file)} alt={`${showing.label} from ${incident.drone_id}`} />
          : <EmptyImage ratio label="No photograph" />}
      </div>
      <figcaption>
        <span className={styles.plateTitle}><CameraIcon />{showing?.label ?? "Photograph"}</span>
        {faces.length > 1 && (
          <span className={styles.faces} role="group" aria-label="Which image to show">
            {faces.map((option, index) => (
              <button key={option.key} type="button" data-active={index === face} onClick={() => setFace(index)}>
                {option.label}
              </button>
            ))}
          </span>
        )}
        {incident.generating && (
          <span className={styles.pending}>
            <i />n8n is still generating its view{incident.progress ? ` - ${incident.progress}%` : ""}
          </span>
        )}
        {showing?.note && <span className={styles.caption}>{showing.note}</span>}
        {incident.generation_error && (
          <span className={styles.warn}>No generated view: {incident.generation_error}</span>
        )}
      </figcaption>
    </figure>
  );
}

/** Where a report is in the pipeline, while it is still in one. */
function Progress({ incident }: { incident: Incident }) {
  if (incident.status === "done") return null;
  if (incident.status === "failed") {
    return <p className={styles.warn}>This report failed: {incident.error ?? "no reason given"}</p>;
  }
  const where = incident.status === "generating"
    ? `n8n is captioning the photograph${incident.progress ? ` - ${incident.progress}%` : ""}`
    : "the analyst is writing it up";
  return <p className={styles.working}><i />{where}</p>;
}

/** The numbers the write-up was built from, so a reader can check it against them. */
function Readings({ incident }: { incident: Incident }) {
  const { scene } = incident;
  return (
    <section className={styles.readings} aria-label="Readings">
      <ul className={styles.figures}>
        <li><b>{scene.fires_nearby}</b><span>burning columns in range</span></li>
        <li><b>{scene.nearest_fire === null ? "—" : `${Math.round(scene.nearest_fire)}m`}</b><span>to the nearest flame</span></li>
        <li><b>{scene.events.length}</b><span>events in 15 minutes</span></li>
        <li><b>{scene.hot_total}</b><span>burning in the world</span></li>
        <li><b>{incident.shots}</b><span>photographs</span></li>
      </ul>

      {scene.events.length > 0 && (
        <ol className={styles.log}>
          {scene.events.slice(0, 5).map((event) => (
            <li key={event.id}>
              <b>{event.kind}</b>
              <span>{Math.round(event.x)}, {Math.round(event.z)} · radius {event.radius}</span>
              <span>{event.status}{event.affected !== null && ` · ${event.affected} blocks`}</span>
            </li>
          ))}
        </ol>
      )}

      {scene.observations.length > 0 && (
        <ol className={styles.log}>
          {scene.observations.slice(0, 4).map((observation) => (
            <li key={observation.id} data-severity={observation.severity}>
              <b>{observation.type}</b>
              <span>{observation.message}</span>
            </li>
          ))}
        </ol>
      )}

      {(incident.note || incident.world_url || !scene.live) && (
        <p className={styles.footnotes}>
          {incident.note && <span>Asked for: {incident.note}</span>}
          {!scene.live && <span>The world feed was stale when this was taken.</span>}
          {incident.world_url && (
            <a href={incident.world_url} target="_blank" rel="noreferrer">Open the generated world</a>
          )}
        </p>
      )}
    </section>
  );
}

/**
 * The reports, polled while this tab is the one on screen.
 *
 * <p>It speeds up on its own while one is being written, so a photograph taken a moment ago
 * fills in without a wall of idle requests the rest of the time.
 */
function useIncidents(active: boolean) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [analyst, setAnalyst] = useState<AnalystInfo | null>(null);
  const [offline, setOffline] = useState(false);
  const [nonce, setNonce] = useState(0);

  const working = incidents.some(isWorking);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const body = await getIncidents(controller.signal);
        if (cancelled) return;
        setIncidents(body.incidents);
        setAnalyst(body.analyst);
        setOffline(false);
      } catch {
        if (!cancelled) setOffline(true);
      }
    };

    void poll();
    const timer = window.setInterval(poll, working ? WORKING_INTERVAL_MS : IDLE_INTERVAL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [active, working, nonce]);

  return { incidents, analyst, offline, refresh: useCallback(() => setNonce((n) => n + 1), []) };
}

/** Which drones there are to photograph with. */
function useDrones(active: boolean) {
  const [drones, setDrones] = useState<string[]>([]);
  const held = useRef<string[]>([]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const roster = await getRoster(controller.signal);
        if (cancelled) return;
        const ids = roster.drones.map((drone) => drone.id);
        // The picker is a controlled select; replacing an identical list every five seconds
        // would reset it under whoever is choosing from it.
        if (ids.join() !== held.current.join()) {
          held.current = ids;
          setDrones(ids);
        }
      } catch {
        // No roster is the same as no drones, which the picker already says.
      }
    };

    void poll();
    const timer = window.setInterval(poll, ROSTER_INTERVAL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [active]);

  return drones;
}

function ago(iso: string) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const units = [[86400, "d"], [3600, "h"], [60, "m"]] as const;
  const [size, label] = units.find(([step]) => seconds >= step) ?? units[2];
  return `${Math.floor(seconds / size)}${label} ago`;
}

function stamp(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : new Intl.DateTimeFormat("en-CA", {
    month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}
