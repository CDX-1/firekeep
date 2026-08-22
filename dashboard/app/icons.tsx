import styles from "./icons.module.css";

/**
 * The placeholder that stands in until a feed actually sends a frame.
 *
 * `label` is worth setting whenever the reason is known - "connecting" and "nothing there"
 * look identical to an operator otherwise.
 */
export function EmptyImage({ ratio = false, label = "No image received" }: { ratio?: boolean; label?: string }) {
  return (
    <span className={styles.emptyImage} data-ratio={ratio}>
      <ImageIcon />
      <span>{label}</span>
    </span>
  );
}

export function Chevron({ direction }: { direction: "left" | "right" }) {
  const paths = { left: "m14.5 4-8 8 8 8", right: "m9.5 4 8 8-8 8" };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[direction]} /></svg>;
}

export function ImageIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="17" height="16" rx="1" /><circle cx="8.5" cy="9" r="1.4" /><path d="m4 17 4.8-4.8 3.15 3.15 2.25-2.25L20 19" /></svg>;
}

export function CameraIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 4.5 10.4 3h3.2l1.2 1.5H18A2.5 2.5 0 0 1 20.5 7v9A2.5 2.5 0 0 1 18 18.5H6A2.5 2.5 0 0 1 3.5 16V7A2.5 2.5 0 0 1 6 4.5h3.2Z" /><circle cx="12" cy="11.5" r="3" /></svg>;
}

export function SearchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4 4" /></svg>;
}

export function GridIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1" /><rect x="13.5" y="3.5" width="7" height="7" rx="1" /><rect x="3.5" y="13.5" width="7" height="7" rx="1" /><rect x="13.5" y="13.5" width="7" height="7" rx="1" /></svg>;
}

export function WorldsIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5Z" /></svg>;
}

export function UploadIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5V4m0 0L8 8m4-4 4 4" /><path d="M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15" /></svg>;
}

export function MapIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4.5 3.5 6.8v12.7L9 17.2l6 2.3 5.5-2.3V4.5L15 6.8Z" /><path d="M9 4.5v12.7M15 6.8v12.7" /></svg>;
}

export function FlameIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2c2.6 3.1 4.3 5.3 4.3 7.6a3.1 3.1 0 0 1-2 2.9c.5-1.6.1-3.1-1-4.4-.4 2.6-1.8 3.4-3 4.7A5 5 0 0 0 9 17.3a5.2 5.2 0 0 0 3 4.5 5.6 5.6 0 0 1-6.2-5.6c0-4 3.6-5.7 4.3-9.6.1-.8.1-1.7 0-2.5a10 10 0 0 0 1.9-1Z" /><path d="M12 21.8a5.6 5.6 0 0 0 6.2-5.6" /></svg>;
}

export function ActivityIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>;
}
