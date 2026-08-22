"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./generated-worlds.module.css";
import { Chevron, EmptyImage, UploadIcon } from "./icons";
import { assetUrl, capture, getHealth, getJobs } from "@/lib/api";
import { BACKENDS, type Backend, type Health, type Job } from "@/lib/types";

/** Nothing in flight means nothing is going to change for a while. */
const IDLE_INTERVAL_MS = 6_000;
const WORKING_INTERVAL_MS = 2_000;

const WORKING: Job["status"][] = ["queued", "generating"];

/**
 * Every screenshot the server has been given, and whatever came back.
 *
 * <p>A capture takes minutes, so a job is on screen from the moment it is queued: first as the
 * screenshot that was sent, then as the generated image once the backend hands one over. Which
 * backend did the work is worth showing - marble spends this project's credits, wildfire is the
 * n8n workflow spending its own.
 */
export default function GeneratedWorlds({ active }: { active: boolean }) {
  const { jobs, offline, refresh } = useJobs(active);
  const [health, setHealth] = useState<Health | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const openIndex = openId ? jobs.findIndex((job) => job.id === openId) : -1;
  const openJob = openIndex >= 0 ? jobs[openIndex] : null;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const poll = () => getHealth().then((next) => !cancelled && setHealth(next)).catch(() => !cancelled && setHealth(null));
    poll();
    const timer = window.setInterval(poll, IDLE_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active]);

  // A job that is gone from the roster takes the viewer down with it.
  useEffect(() => {
    if (openId && openIndex < 0) setOpenId(null);
  }, [openId, openIndex]);

  const move = (offset: number) => {
    if (openIndex < 0) return;
    setOpenId(jobs[(openIndex + offset + jobs.length) % jobs.length].id);
  };

  useEffect(() => {
    if (!openJob) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenId(null);
      if (event.key === "ArrowLeft") move(-1);
      if (event.key === "ArrowRight") move(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openJob, openIndex, jobs]);

  return (
    <div className={styles.workspace}>
      <div className={styles.bar}>
        <Status health={health} offline={offline} jobs={jobs} />
        <Send backend={health?.backend ?? "wildfire"} onSent={refresh} />
      </div>

      <section className={styles.grid} aria-label="Generated worlds">
        {jobs.map((job) => (
          <Card key={job.id} job={job} onOpen={() => setOpenId(job.id)} />
        ))}
        {jobs.length === 0 && (
          <p className={styles.notice}>
            {offline
              ? "No capture server on /backend - start python/server.py."
              : "Nothing generated yet. Take a screenshot in game, or send one from here."}
          </p>
        )}
      </section>

      {openJob && (
        <Viewer
          job={openJob}
          siblings={jobs.length}
          onClose={() => setOpenId(null)}
          onMove={move}
        />
      )}
    </div>
  );
}

/** Where the pipeline stands: what the server is doing and what it will cost. */
function Status({ health, offline, jobs }: { health: Health | null; offline: boolean; jobs: Job[] }) {
  const working = jobs.filter((job) => WORKING.includes(job.status)).length;
  return (
    <p className={styles.status}>
      <span data-live={!offline && Boolean(health)} />
      {offline || !health
        ? "waiting for the capture server"
        : health.dry_run
          ? "dry run - screenshots are echoed back, nothing is generated"
          : health.backend === "wildfire"
            ? "wildfire - n8n writes the prompt and pays for the generation"
            : `marble - ${health.model}, ${typeof health.credits === "number" ? `${Math.round(health.credits)} credits left` : health.credits}`}
      {working > 0 && <em>{working} in flight</em>}
    </p>
  );
}

/** Send a screenshot by hand, the same way the mod does. */
function Send({ backend, onSent }: { backend: Backend; onSent: () => void }) {
  const [choice, setChoice] = useState<Backend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  // Until somebody picks one, follow whatever the server was started with.
  const using = choice ?? backend;

  const send = async (file: File | undefined) => {
    if (!file) return;
    setSending(true);
    setError(null);
    try {
      await capture(file, { backend: using });
      onSent();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "could not send that screenshot");
    } finally {
      setSending(false);
      if (picker.current) picker.current.value = "";           // so the same file can go twice
    }
  };

  return (
    <div className={styles.send}>
      {error && <span className={styles.error}>{error}</span>}
      <label className={styles.backend}>
        <span className="sr-only">Generation backend</span>
        <select value={using} onChange={(event) => setChoice(event.target.value as Backend)}>
          {BACKENDS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
      <button type="button" disabled={sending} onClick={() => picker.current?.click()}>
        <UploadIcon />
        <span>{sending ? "Sending" : "Send a screenshot"}</span>
      </button>
      <input
        ref={picker}
        className="sr-only"
        type="file"
        accept="image/png,image/jpeg"
        onChange={(event) => void send(event.target.files?.[0])}
      />
    </div>
  );
}

function Card({ job, onOpen }: { job: Job; onOpen: () => void }) {
  const result = resultUrl(job);
  return (
    <article className={styles.card}>
      <button className={styles.thumb} type="button" onClick={onOpen} aria-label={`Open capture ${job.id}`}>
        {/* Until the world comes back there is still the screenshot that was sent, which is
            more use than an empty tile - dimmed, so it is never mistaken for the result. */}
        {result
          ? <img src={result} alt={job.caption ?? `world generated from capture ${job.id}`} />
          : job.status === "failed"
            ? <EmptyImage ratio label="Nothing came back" />
            : <img className={styles.pending} src={assetUrl(job.id, job.source_file)} alt={`screenshot sent as capture ${job.id}`} />}
        {job.status !== "done" && (
          <span className={styles.progress} data-status={job.status}>
            {job.status === "failed" ? "failed" : job.status === "queued" ? "queued" : `generating${job.progress ? ` ${job.progress}%` : ""}`}
          </span>
        )}
      </button>
      <p className={styles.caption}>
        <b>{backendOf(job)}</b>
        <span>{job.caption ?? job.error ?? job.generated_prompt ?? job.source}</span>
        <time dateTime={job.created}>{ago(job.created)}</time>
      </p>
    </article>
  );
}

/** One capture full size, with the screenshot it came from a click away. */
function Viewer({ job, siblings, onClose, onMove }: {
  job: Job;
  siblings: number;
  onClose: () => void;
  onMove: (offset: number) => void;
}) {
  const [showSource, setShowSource] = useState(false);
  const result = resultUrl(job);
  const source = assetUrl(job.id, job.source_file);
  const prompt = job.generated_prompt ?? job.prompt;
  const world = job.world_url ?? job.marble_url;

  // Every capture has a screenshot; not every capture has a result to switch back from.
  useEffect(() => setShowSource(false), [job.id]);

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={`Capture ${job.id}`}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className={styles.viewer} data-single={siblings < 2}>
        {siblings > 1 && (
          <button className={styles.arrow} type="button" aria-label="Previous capture" onClick={() => onMove(-1)}>
            <Chevron direction="left" />
          </button>
        )}
        <div className={styles.panel}>
          <div className={styles.panelImage}>
            {showSource || !result
              ? <img src={source} alt={`screenshot sent as capture ${job.id}`} />
              : <img src={result} alt={job.caption ?? `world generated from capture ${job.id}`} />}
          </div>
          <div className={styles.meta}>
            <p>
              <b>{backendOf(job)}</b>
              <span>{job.model}</span>
              <span>{job.status}{job.took_seconds ? ` in ${job.took_seconds}s` : ""}</span>
              {job.estimated_credits > 0 && <span>{job.estimated_credits} credits</span>}
              <time dateTime={job.created}>{ago(job.created)}</time>
            </p>
            {(job.caption || job.error) && <p className={styles.line} data-error={Boolean(job.error)}>{job.error ?? job.caption}</p>}
            {prompt && <p className={styles.prompt}>{prompt}</p>}
            <p className={styles.links}>
              {result && (
                <button type="button" onClick={() => setShowSource((showing) => !showing)}>
                  {showSource ? "Show the world" : "Show the screenshot"}
                </button>
              )}
              {result && <a href={result} target="_blank" rel="noreferrer">Open the image</a>}
              {world && <a href={world} target="_blank" rel="noreferrer">Open the world</a>}
            </p>
          </div>
        </div>
        {siblings > 1 && (
          <button className={styles.arrow} type="button" aria-label="Next capture" onClick={() => onMove(1)}>
            <Chevron direction="right" />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The job list, polled while this tab is the one on screen.
 *
 * <p>It speeds up on its own while something is queued or generating, so a capture you just sent
 * fills in quickly without a wall of idle requests the rest of the time.
 */
function useJobs(active: boolean) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [offline, setOffline] = useState(false);
  const [nonce, setNonce] = useState(0);

  const working = jobs.some((job) => WORKING.includes(job.status));

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const next = await getJobs(controller.signal);
        if (cancelled) return;
        setJobs(next);
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

  return { jobs, offline, refresh: useCallback(() => setNonce((n) => n + 1), []) };
}

/** The generated image, or null while there is nothing but the screenshot. */
function resultUrl(job: Job) {
  // pano first: it is the sharpest thing either backend produces. A wildfire payload is
  // somebody else's JSON, so anything else that was saved beats showing nothing.
  const file = job.assets.pano ?? job.assets.preview ?? Object.values(job.assets).find(Boolean);
  return file ? assetUrl(job.id, file) : null;
}

/** Older jobs predate the backend field; everything back then went to Marble. */
function backendOf(job: Job) {
  return job.backend ?? "marble";
}

function ago(iso: string) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const units = [[86400, "d"], [3600, "h"], [60, "m"]] as const;
  const [size, label] = units.find(([step]) => seconds >= step) ?? units[2];
  return `${Math.floor(seconds / size)}${label} ago`;
}
