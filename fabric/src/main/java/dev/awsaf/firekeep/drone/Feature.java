package dev.awsaf.firekeep.drone;

/**
 * One thing worth mentioning near the drone - a tree, a burning roof, a pond - after a whole
 * cluster of blocks has been collapsed into a single sentence's worth of fact.
 */
public record Feature(
        String type,
        String direction,
        double distance,
        int size,
        int x,
        int y,
        int z) {
}
