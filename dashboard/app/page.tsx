"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { assetUrl, capture, getHealth, getJobs } from "@/lib/api";
import type { Health, Job } from "@/lib/types";
import styles from "./page.module.css";

const POLL_MS = 2000;

export default function Dashboard() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // poll the Python server
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const [h, j] = await Promise.all([
        getHealth().catch(() => null),
        getJobs().catch(() => null),
      ]);
      if (!alive) return;
      setHealth(h);
      if (j) setJobs(j);
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // follow the newest job until the user picks one themselves
  const selected = jobs.find((j) => j.id === selectedId) ?? jobs[0] ?? null;

  const onUpload = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const { job_id } = await capture(file);
      setSelectedId(job_id);
    } catch (e) {
      alert(`Capture failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setUploading(false);
    }
  }, []);

  const offline = !health;

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <h1>firekeep</h1>
        <span className={styles.dot} data-off={offline} />
        {health ? (
          <div className={styles.stats}>
            <span>
              <b>{typeof health.credits === "number" ? Math.round(health.credits) : "?"}</b> credits
            </span>
            <span>
              <b>{health.busy}</b> running
            </span>
            <span>
              <b>{health.queued}</b> queued
            </span>
            <span>{health.model}</span>
          </div>
        ) : (
          <div className={styles.stats}>server offline — is server.py running?</div>
        )}
        {health?.dry_run && <span className={styles.badge}>dry run</span>}

        <div className={styles.spacer} />

        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
            e.target.value = "";
          }}
        />
        <button onClick={() => fileInput.current?.click()} disabled={offline || uploading}>
          {uploading ? "uploading…" : "capture a screenshot"}
        </button>
      </header>

      <div className={styles.body}>
        <nav className={styles.list}>
          {jobs.length === 0 && (
            <p className={styles.empty}>
              No captures yet. Take a screenshot in Minecraft, or POST one to <code>/capture</code>.
            </p>
          )}
          {jobs.map((job) => (
            <button
              key={job.id}
              className={styles.job}
              data-on={selected?.id === job.id}
              onClick={() => setSelectedId(job.id)}
            >
              {job.assets?.preview ? (
                // plain img: these come through the proxy, not the Next image optimizer
                // eslint-disable-next-line @next/next/no-img-element
                <img src={assetUrl(job.id, job.assets.preview)} alt="" />
              ) : (
                <div className={styles.ph}>{job.status === "failed" ? "⚠" : "⋯"}</div>
              )}
              <div>
                <div className={styles.name}>{job.source || job.id}</div>
                <div className={styles.meta}>
                  <span className={`${styles.tag} ${styles[job.status]}`}>{job.status}</span>
                  <span>{job.created?.replace("T", " ").slice(5, 16)}</span>
                  {job.status === "generating" && job.progress != null && <span>{job.progress}%</span>}
                </div>
              </div>
            </button>
          ))}
        </nav>

        <main className={styles.detail}>
          {selected ? <Detail job={selected} /> : <div className={styles.blank}>nothing selected</div>}
        </main>
      </div>
    </div>
  );
}

function Detail({ job }: { job: Job }) {
  return (
    <>
      <h2>{job.source || job.id}</h2>
      <p className={styles.sub}>
        {job.model} · {job.status}
        {job.took_seconds ? ` · ${job.took_seconds}s` : ""}
      </p>

      {job.error && <p className={styles.error}>{job.error}</p>}

      {job.assets?.pano ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.pano} src={assetUrl(job.id, job.assets.pano)} alt="360 panorama" />
      ) : job.assets?.preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.pano} src={assetUrl(job.id, job.assets.preview)} alt="preview" />
      ) : (
        <p className={styles.caption}>
          {job.status === "done" ? "No imagery for this job." : "Waiting for the world…"}
        </p>
      )}

      <dl className={styles.grid}>
        <div className={styles.card}>
          <dt>credits</dt>
          <dd>{job.estimated_credits}</dd>
        </div>
        <div className={styles.card}>
          <dt>captured</dt>
          <dd>{job.created?.replace("T", " ").slice(0, 16)}</dd>
        </div>
        <div className={styles.card}>
          <dt>size</dt>
          <dd>{(job.bytes / 1e6).toFixed(1)} MB</dd>
        </div>
        {job.marble_url && (
          <div className={styles.card}>
            <dt>world</dt>
            <dd>
              <a href={job.marble_url} target="_blank" rel="noopener noreferrer">
                open in Marble ↗
              </a>
            </dd>
          </div>
        )}
      </dl>

      {job.caption && <p className={styles.caption}>{job.caption}</p>}
    </>
  );
}
