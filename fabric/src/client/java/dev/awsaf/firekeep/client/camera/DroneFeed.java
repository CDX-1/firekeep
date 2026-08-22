package dev.awsaf.firekeep.client.camera;

import dev.awsaf.firekeep.entity.DroneEntity;

import java.util.UUID;

/**
 * One drone's live feed: the newest encoded frame, and whoever is waiting for the next one.
 *
 * <p>Written from the client thread, read from the HTTP threads, so the frame handoff is a single
 * volatile reference to an immutable record plus a monitor for the waiters.
 */
public final class DroneFeed {
    /** A feed with no viewers for this long stops being rendered. */
    private static final long VIEWER_GRACE_MILLIS = 2_500L;

    /**
     * How long a request to be rendered at a given profile stands without being renewed.
     *
     * <p>A stream renews on every frame it forwards, so this only ever runs out once the last
     * viewer has gone - which is exactly when a drone should stop being rendered at 720p.
     */
    private static final long PROFILE_TTL_MILLIS = 3_000L;

    private final UUID uuid;
    private final String id;
    /** True while the feed is named after the entity id, because the drone had no label yet. */
    private final boolean placeholderName;
    private final int entityId;

    private final Object frameLock = new Object();
    private volatile Frame frame;
    private volatile long sequence;
    /** Handed out at capture time, so frames can be put back in order after encoding. */
    private final java.util.concurrent.atomic.AtomicLong captures = new java.util.concurrent.atomic.AtomicLong();

    /** Viewers holding an open stream, plus the last time somebody asked for a single frame. */
    private volatile int subscribers;
    private volatile long lastSnapshotRequest;
    private volatile long lastCaptureStart;

    /** What this feed is being rendered at, and until when. Null once nothing has asked. */
    private volatile CameraConfig.Profile profile;
    private volatile long profileUntil;

    private volatile double x;
    private volatile double y;
    private volatile double z;
    private volatile float yaw;

    public DroneFeed(DroneEntity drone, String id, boolean placeholderName) {
        this.uuid = drone.getUUID();
        this.id = id;
        this.placeholderName = placeholderName;
        this.entityId = drone.getId();
        this.track(drone);
    }

    public record Frame(byte[] jpeg, int width, int height, long sequence, long capturedAt) {
    }

    public UUID uuid() {
        return this.uuid;
    }

    public String id() {
        return this.id;
    }

    public boolean hasPlaceholderName() {
        return this.placeholderName;
    }

    public int entityId() {
        return this.entityId;
    }

    public double x() {
        return this.x;
    }

    public double y() {
        return this.y;
    }

    public double z() {
        return this.z;
    }

    public float yaw() {
        return this.yaw;
    }

    public Frame latest() {
        return this.frame;
    }

    /**
     * What this feed should be rendered at right now.
     *
     * <p>The grid profile once whatever asked for something better has gone away, so a drone that
     * was being watched closely quietly costs a thumbnail again rather than staying expensive.
     */
    public CameraConfig.Profile profile() {
        CameraConfig.Profile requested = this.profile;
        if (requested == null || System.currentTimeMillis() > this.profileUntil) {
            return CameraConfig.grid();
        }
        return requested;
    }

    /**
     * Asks for this feed to be rendered at {@code wanted}, for a few seconds.
     *
     * <p>Heavier requests win. Two things can be looking at one drone - a tile showing a thumbnail
     * while the expanded viewer streams it - and the grid asking for its 480p every second must not
     * keep pulling the viewer back down. The heavier request simply outlives the lighter one.
     */
    public void requestProfile(CameraConfig.Profile wanted) {
        if (wanted == null) {
            return;
        }
        long now = System.currentTimeMillis();
        synchronized (this.frameLock) {
            CameraConfig.Profile current = this.profile;
            boolean expired = current == null || now > this.profileUntil;
            if (expired || wanted.weight() >= current.weight()) {
                this.profile = wanted;
                this.profileUntil = now + PROFILE_TTL_MILLIS;
            }
        }
    }

    public long lastCaptureStart() {
        return this.lastCaptureStart;
    }

    public void markCaptureStarted(long now) {
        this.lastCaptureStart = now;
    }

    /** Mirrors the live entity so the HTTP threads never touch level state. */
    public void track(DroneEntity drone) {
        this.x = drone.getX();
        this.y = drone.getY();
        this.z = drone.getZ();
        this.yaw = drone.getYRot();
    }

    /** Claims the next capture's place in line. Called on the render thread, before encoding. */
    public long nextCapture() {
        return this.captures.incrementAndGet();
    }

    /**
     * Publishes an encoded frame, unless a newer one has already gone out.
     *
     * <p>Encoding runs on a pool, so two frames of the same feed can be in flight at once and the
     * second can finish first - a big frame behind a small one, or simply an unlucky scheduler.
     * Publishing it anyway would put an older picture on screen under a newer sequence number,
     * which every viewer would then hold on to. The late one is dropped instead: a dropped frame
     * is invisible at these rates, and a frame that goes backwards is exactly the judder this is
     * all trying to remove.
     *
     * @param capture the value {@link #nextCapture()} gave this frame when it was taken
     */
    public void publish(long capture, byte[] jpeg, int width, int height) {
        synchronized (this.frameLock) {
            if (capture <= this.sequence) {
                return;
            }
            this.sequence = capture;
            this.frame = new Frame(jpeg, width, height, capture, System.currentTimeMillis());
            this.frameLock.notifyAll();
        }
    }

    /**
     * Blocks until a frame newer than {@code seenSequence} arrives.
     *
     * @return the new frame, or null if none arrived before the timeout
     */
    public Frame awaitFrame(long seenSequence, long timeoutMillis) throws InterruptedException {
        synchronized (this.frameLock) {
            if (this.sequence <= seenSequence) {
                this.frameLock.wait(timeoutMillis);
            }
            return this.sequence > seenSequence ? this.frame : null;
        }
    }

    public void addSubscriber() {
        synchronized (this.frameLock) {
            this.subscribers++;
        }
    }

    public void removeSubscriber() {
        synchronized (this.frameLock) {
            this.subscribers = Math.max(0, this.subscribers - 1);
        }
    }

    public int subscribers() {
        return this.subscribers;
    }

    public void requestSnapshot() {
        this.lastSnapshotRequest = System.currentTimeMillis();
    }

    /** Nobody is looking, so nothing needs rendering: a drone costs nothing until it is on screen. */
    public boolean isWatched(long now) {
        return this.subscribers > 0 || now - this.lastSnapshotRequest < VIEWER_GRACE_MILLIS;
    }

    /** Wakes any stream waiting on this feed so it can notice the drone is gone. */
    public void close() {
        synchronized (this.frameLock) {
            this.frameLock.notifyAll();
        }
    }
}
