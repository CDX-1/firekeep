package dev.awsaf.firekeep.drone;

/**
 * One entity the drone can see, already reduced to what a rescue decision needs: what it is,
 * which way it lies, how far, and whether it is in trouble.
 */
public record EntitySighting(
        String id,
        String type,
        String category,
        double x,
        double y,
        double z,
        String direction,
        double distance,
        boolean onFire,
        Float health) {
}
