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

export function MapIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4.5 3.5 6.8v12.7L9 17.2l6 2.3 5.5-2.3V4.5L15 6.8Z" /><path d="M9 4.5v12.7M15 6.8v12.7" /></svg>;
}
