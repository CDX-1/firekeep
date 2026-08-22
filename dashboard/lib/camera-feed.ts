/**
 * One connection for every camera on the page.
 *
 * The dashboard used to ask the agents for a picture over and over: a GET per tile per
 * refresh, through a queue that existed only because a browser will not open more than about
 * six connections to one origin and a wall of thumbnails would otherwise starve itself.
 *
 * The Python server now holds the streams open on our behalf, so there is nothing left to
 * poll. This reads one multipart response - `/api/cameras/feed` - carrying the roster and
 * every subscribed drone's frames, and hands each part to whoever is waiting for it. A wall
 * of twelve tiles is one connection, and the tiles paint as fast as the agents render rather
 * than as fast as the browser can be talked into fetching.
 *
 * Frames arrive when they arrive. Nothing here has a timer in it.
 */

import { feedUrl, type Roster } from "./cameras";

/** The multipart boundary the server writes; must match cameras.BOUNDARY. */
const BOUNDARY = "--firekeepfeed";

/** How long a subscription change waits for others before it costs a reconnect. */
const SETTLE_MS = 120;

/**
 * Reconnect backoff after a dropped stream, doubling to the cap.
 *
 * It never stops trying. There was once a give-up count, after which the page went back to
 * fetching stills one at a time; with that gone there is nothing better to do than keep asking,
 * and a server that is restarting - which is the usual reason for a drop - comes back on its own
 * a few seconds later. The status says `retrying` throughout, so a stream that will genuinely
 * never open still says so on screen rather than pretending to connect.
 */
const RETRY_MS = 500;
const RETRY_CAP_MS = 5_000;

export type Connection = "connecting" | "live" | "retrying";

export interface FeedStatus {
  connection: Connection;
  /** Whether the server can reach any agent at all - a different failure from ours. */
  online: boolean;
  agents: number;
  clientFps: number;
  error: string | null;
}

type FrameListener = (frame: Blob) => void;
type RosterListener = (roster: Roster) => void;
type StatusListener = (status: FeedStatus) => void;

/**
 * The page's single feed.
 *
 * Interest is counted per drone: a tile registers what it wants to see and the union of those
 * is what the connection asks for, so the server only pulls a drone off Minecraft while
 * something on screen is actually showing it.
 */
class CameraFeed {
  private wanted = new Map<string, number>();
  private frameListeners = new Map<string, Set<FrameListener>>();
  private rosterListeners = new Set<RosterListener>();
  private statusListeners = new Set<StatusListener>();

  private controller: AbortController | null = null;
  private settle: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = RETRY_MS;
  private failures = 0;
  private connected = "";

  private roster: Roster | null = null;
  private status: FeedStatus = {
    connection: "connecting", online: false, agents: 0, clientFps: 0, error: null,
  };

  // -- what the page wants to see -----------------------------------------

  /** Registers interest in one drone's picture. The returned function gives it up again. */
  want(id: string): () => void {
    this.wanted.set(id, (this.wanted.get(id) ?? 0) + 1);
    this.reconnectSoon();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.wanted.get(id) ?? 1) - 1;
      if (count > 0) this.wanted.set(id, count);
      else this.wanted.delete(id);
      this.reconnectSoon();
    };
  }

  onFrame(id: string, listener: FrameListener): () => void {
    const listeners = this.frameListeners.get(id) ?? new Set();
    listeners.add(listener);
    this.frameListeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.frameListeners.delete(id);
    };
  }

  onRoster(listener: RosterListener): () => void {
    this.rosterListeners.add(listener);
    // A tile that mounts later should not have to wait for the next roster to know anything.
    if (this.roster) listener(this.roster);
    return () => this.rosterListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  /** Opens the connection if it is not already open. Safe to call repeatedly. */
  open() {
    if (this.controller || this.retry) return;
    this.connect();
  }

  /** Drops the connection. The page does this when it goes away, and not otherwise. */
  close() {
    if (this.settle) clearTimeout(this.settle);
    if (this.retry) clearTimeout(this.retry);
    this.settle = this.retry = null;
    this.controller?.abort();
    this.controller = null;
    this.connected = "";
  }

  // -- the connection ------------------------------------------------------

  private ids() {
    return [...this.wanted.keys()].sort();
  }

  /**
   * Reconnects once the subscription has stopped changing.
   *
   * Which drones the feed carries is part of its URL, so changing the set means a new request.
   * Opening a filter changes a dozen tiles at once, and that should cost one reconnection
   * rather than a dozen.
   */
  private reconnectSoon() {
    if (this.settle) clearTimeout(this.settle);
    this.settle = setTimeout(() => {
      this.settle = null;
      if (this.ids().join(",") === this.connected) return;
      this.controller?.abort();
      this.controller = null;
      if (this.retry) {
        clearTimeout(this.retry);
        this.retry = null;
      }
      this.connect();
    }, SETTLE_MS);
  }

  private connect() {
    const ids = this.ids();
    const controller = new AbortController();
    this.controller = controller;
    this.connected = ids.join(",");
    this.publishStatus({ connection: this.failures > 0 ? "retrying" : "connecting" });

    void (async () => {
      try {
        const response = await fetch(feedUrl(ids), { cache: "no-store", signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`feed -> ${response.status}`);
        this.failures = 0;
        this.retryDelay = RETRY_MS;
        this.publishStatus({ connection: "live", error: null });
        await readParts(response.body, (headers, body) => this.deliver(headers, body));
        throw new Error("the feed ended");
      } catch (cause) {
        if (controller.signal.aborted) return;
        this.onDropped(cause);
      }
    })();
  }

  private onDropped(cause: unknown) {
    this.controller = null;
    this.connected = "";
    this.failures += 1;
    const error = cause instanceof Error ? cause.message : String(cause);

    this.publishStatus({ connection: "retrying", error });
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, this.retryDelay);
    this.retryDelay = Math.min(RETRY_CAP_MS, this.retryDelay * 2);
  }

  private deliver(headers: Map<string, string>, body: Uint8Array) {
    if (headers.get("x-firekeep-event") === "frame") {
      const id = headers.get("x-drone-id");
      if (!id) return;
      const listeners = this.frameListeners.get(id);
      if (!listeners?.size) return;
      // One Blob for every listener on this drone; they all show the same picture.
      const frame = new Blob([body as BlobPart], { type: "image/jpeg" });
      for (const listener of listeners) listener(frame);
      return;
    }

    const text = new TextDecoder().decode(body);
    const roster = JSON.parse(text) as Roster;
    this.roster = roster;
    this.publishStatus({
      online: roster.online, agents: roster.agents, clientFps: roster.clientFps,
    });
    for (const listener of this.rosterListeners) listener(roster);
  }

  private publishStatus(patch: Partial<FeedStatus>) {
    const next = { ...this.status, ...patch };
    if (next.connection === this.status.connection && next.online === this.status.online
      && next.agents === this.status.agents && next.clientFps === this.status.clientFps
      && next.error === this.status.error) {
      return;
    }
    this.status = next;
    for (const listener of this.statusListeners) listener(next);
  }
}

/**
 * The parser.
 *
 * A multipart body is a boundary, some headers, a length, and that many bytes - repeated. This
 * reads exactly that, because a browser will happily stream a multipart response but will only
 * decode one for you inside an `<img>`, which is no use when the parts are for twelve
 * different tiles.
 */
async function readParts(
  stream: ReadableStream<Uint8Array>,
  onPart: (headers: Map<string, string>, body: Uint8Array) => void,
) {
  const reader = stream.getReader();
  const boundary = new TextEncoder().encode(BOUNDARY);
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer = concat(buffer, value);

    for (;;) {
      const start = indexOf(buffer, boundary, 0);
      if (start < 0) break;

      const headerEnd = indexOfCRLFCRLF(buffer, start);
      if (headerEnd < 0) break;                       // headers still arriving

      const headers = parseHeaders(buffer.subarray(start + boundary.length, headerEnd));
      const length = Number(headers.get("content-length") ?? NaN);
      if (!Number.isFinite(length)) {
        buffer = buffer.subarray(headerEnd + 4);      // not a part we understand; skip it
        continue;
      }

      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) break;  // body still arriving

      // Copied, not a view: the caller keeps it in a Blob and the buffer moves on.
      onPart(headers, buffer.slice(bodyStart, bodyStart + length));
      buffer = buffer.subarray(bodyStart + length);
    }

    // The leftover is a view into a buffer we no longer need all of; copy it small.
    if (buffer.byteOffset > 1 << 20) buffer = buffer.slice();
  }
}

function parseHeaders(bytes: Uint8Array): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of new TextDecoder().decode(bytes).split("\r\n")) {
    const at = line.indexOf(":");
    if (at > 0) headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return headers;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBufferLike> {
  if (left.length === 0) return right;
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number) {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function indexOfCRLFCRLF(bytes: Uint8Array, from: number) {
  for (let i = from; i <= bytes.length - 4; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
  }
  return -1;
}

/** One per page. The feed is shared by every tile, which is the entire point of it. */
export const cameraFeed = new CameraFeed();
