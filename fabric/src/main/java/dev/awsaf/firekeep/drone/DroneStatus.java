package dev.awsaf.firekeep.drone;

/**
 * What a drone is doing right now, in the words the coordinating AI uses to pick one.
 *
 * <p>{@link #AVAILABLE} is the only state that means "give me a job"; everything else is either
 * busy or broken, and {@link #dispatchable()} is the single place that distinction lives.
 */
public enum DroneStatus {
    AVAILABLE("available"),
    MOVING("moving"),
    SCANNING("scanning"),
    RESPONDING("responding"),
    DISPENSING("dispensing"),
    RETURNING("returning"),
    FOLLOWING("following"),
    STUCK("stuck"),
    OFFLINE("offline");

    private final String label;

    DroneStatus(String label) {
        this.label = label;
    }

    public String label() {
        return this.label;
    }

    /** True when the fleet coordinator may hand this drone a new mission without cancelling one. */
    public boolean dispatchable() {
        return this == AVAILABLE || this == STUCK;
    }
}
