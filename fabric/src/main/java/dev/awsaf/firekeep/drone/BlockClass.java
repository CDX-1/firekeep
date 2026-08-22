package dev.awsaf.firekeep.drone;

import net.minecraft.core.BlockPos;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CampfireBlock;
import net.minecraft.world.level.block.state.BlockState;

/**
 * The handful of categories a disaster-response agent actually reasons about.
 *
 * <p>This is the whole point of doing perception inside the mod: a block scan produces thousands
 * of distinct block states, and none of that detail helps an AI decide where to fly. Collapsing
 * every state into one of these eleven classes is what turns a 5,000-block scan into a paragraph.
 *
 * <p>Ordering is not arbitrary - {@link #priority()} decides what a column shows on the coarse
 * map when several classes stack up in it, and hazards must win over scenery.
 */
public enum BlockClass {
    AIR('.', "air"),
    FIRE('F', "fire"),
    LAVA('L', "lava"),
    WATER('W', "water"),
    /** Grass, flowers, carpets, snow layers - ground cover a drone flies straight through. */
    PLANT(',', "plant"),
    /** Canopy. Minecraft leaves are full solid blocks, whatever they look like. */
    FOLIAGE('t', "foliage"),
    WOOD('T', "tree"),
    TERRAIN('#', "terrain"),
    BUILDING('B', "building"),
    HAZARD('!', "hazard"),
    OBSTACLE('o', "obstacle"),
    /** Outside a loaded chunk or the build height: unknown, and therefore not safe to fly into. */
    UNKNOWN('?', "unknown");

    private static final BlockClass[] VALUES = values();

    private final char glyph;
    private final String label;

    BlockClass(char glyph, String label) {
        this.glyph = glyph;
        this.label = label;
    }

    public char glyph() {
        return this.glyph;
    }

    public String label() {
        return this.label;
    }

    public static BlockClass byOrdinal(int ordinal) {
        return ordinal >= 0 && ordinal < VALUES.length ? VALUES[ordinal] : UNKNOWN;
    }

    /**
     * True for anything a drone must not fly into.
     *
     * <p>Fire and water are not blocking - they are flyable, just unwise, which is why hazard
     * avoidance is a separate question from obstruction.
     */
    public boolean blocking() {
        return switch (this) {
            case AIR, PLANT, WATER, FIRE -> false;
            default -> true;
        };
    }

    /** True for anything that will damage a drone that flies into it. */
    public boolean dangerous() {
        return this == FIRE || this == LAVA || this == HAZARD;
    }

    /** Higher wins when several classes share a column on the coarse map. */
    public int priority() {
        return switch (this) {
            case FIRE -> 100;
            case LAVA -> 90;
            case HAZARD -> 80;
            case BUILDING -> 70;
            case WOOD -> 60;
            case WATER -> 50;
            case OBSTACLE -> 40;
            case TERRAIN -> 30;
            case FOLIAGE -> 20;
            case UNKNOWN -> 10;
            case PLANT -> 5;
            case AIR -> 0;
        };
    }

    // ---------------------------------------------------------------- classification

    /**
     * Sorts one block state into a class. Called once per scanned cell, so it is ordered with the
     * cheap and common cases first: air, then fluids, then the tag checks.
     */
    public static BlockClass of(BlockState state, BlockGetter level, BlockPos pos) {
        if (state.isAir()) {
            return AIR;
        }

        if (!state.getFluidState().isEmpty()) {
            if (state.getFluidState().is(FluidTags.LAVA)) {
                return LAVA;
            }
            if (state.getFluidState().is(FluidTags.WATER) && state.getBlock() == Blocks.WATER) {
                return WATER;
            }
        }

        if (state.is(BlockTags.FIRE)) {
            return FIRE;
        }
        if (state.is(BlockTags.CAMPFIRES) && state.getOptionalValue(CampfireBlock.LIT).orElse(false)) {
            return FIRE;
        }
        if (state.is(Blocks.MAGMA_BLOCK) || state.is(Blocks.LAVA_CAULDRON)) {
            return LAVA;
        }

        if (state.is(BlockTags.LOGS) || state.is(BlockTags.BAMBOO_BLOCKS)) {
            return WOOD;
        }
        if (state.is(BlockTags.LEAVES) || state.is(BlockTags.WART_BLOCKS)) {
            return FOLIAGE;
        }

        if (isHazard(state)) {
            return HAZARD;
        }

        // Anything a drone can fly straight through is ground cover, whatever it is made of.
        // Snow layers, carpets, grass, flowers, crops and vines all land here, and the collision
        // shape is the only test that gets all of them right - a snow-covered field is not a wall,
        // and a leaf block is, however similar the two look from above.
        if (state.getCollisionShape(level, pos).isEmpty()) {
            return PLANT;
        }

        if (isBuilt(state)) {
            return BUILDING;
        }
        if (isNatural(state)) {
            return TERRAIN;
        }
        return OBSTACLE;
    }

    /**
     * Player-made structure. Deliberately generous: telling a burning house apart from a burning
     * hillside is the distinction that matters to a rescue agent, and the false positives here
     * (a jungle temple, a village well) are things worth protecting anyway.
     */
    private static boolean isBuilt(BlockState state) {
        if (state.is(BlockTags.BADLANDS_TERRACOTTA)) {
            return false;                            // natural mesa banding, not a wall
        }
        return state.is(BlockTags.PLANKS) || state.is(BlockTags.WOOL) || state.is(BlockTags.WOOL_CARPETS)
                || state.is(BlockTags.CONCRETE) || state.is(BlockTags.TERRACOTTA)
                || state.is(BlockTags.GLAZED_TERRACOTTA) || state.is(BlockTags.STONE_BRICKS)
                || state.is(BlockTags.STAIRS) || state.is(BlockTags.SLABS) || state.is(BlockTags.WALLS)
                || state.is(BlockTags.FENCES) || state.is(BlockTags.FENCE_GATES) || state.is(BlockTags.DOORS)
                || state.is(BlockTags.TRAPDOORS) || state.is(BlockTags.BEDS) || state.is(BlockTags.ALL_SIGNS)
                || state.is(BlockTags.RAILS) || state.is(BlockTags.LANTERNS) || state.is(BlockTags.CANDLES)
                || state.is(BlockTags.BANNERS) || state.is(BlockTags.BARS) || state.is(BlockTags.CHAINS)
                || state.is(BlockTags.SHULKER_BOXES) || state.is(BlockTags.FLOWER_POTS)
                || state.is(BlockTags.BEACON_BASE_BLOCKS) || state.is(BlockTags.BUTTONS)
                || state.is(BlockTags.PRESSURE_PLATES) || state.is(BlockTags.BEEHIVES)
                || state.is(Blocks.GLASS) || state.is(Blocks.GLASS_PANE) || state.is(Blocks.BRICKS)
                || state.is(Blocks.CRAFTING_TABLE) || state.is(Blocks.FURNACE) || state.is(Blocks.CHEST)
                || state.is(Blocks.BOOKSHELF) || state.is(Blocks.LADDER) || state.is(Blocks.TORCH)
                || state.is(Blocks.WALL_TORCH) || state.is(Blocks.COBBLESTONE) || state.is(Blocks.SMOOTH_STONE);
    }

    private static boolean isHazard(BlockState state) {
        return state.is(Blocks.POWDER_SNOW) || state.is(Blocks.CACTUS) || state.is(Blocks.SWEET_BERRY_BUSH)
                || state.is(Blocks.WITHER_ROSE) || state.is(Blocks.POINTED_DRIPSTONE)
                || state.is(BlockTags.PORTALS);
    }

    private static boolean isNatural(BlockState state) {
        return state.is(BlockTags.DIRT) || state.is(BlockTags.GRASS_BLOCKS) || state.is(BlockTags.SAND)
                || state.is(BlockTags.MUD) || state.is(BlockTags.MOSS_BLOCKS) || state.is(BlockTags.SNOW)
                || state.is(BlockTags.ICE) || state.is(BlockTags.NYLIUM)
                || state.is(BlockTags.BASE_STONE_OVERWORLD) || state.is(BlockTags.BASE_STONE_NETHER)
                || state.is(BlockTags.BADLANDS_TERRACOTTA)
                || state.is(Blocks.GRAVEL) || state.is(Blocks.CLAY) || state.is(Blocks.OBSIDIAN)
                || state.is(Blocks.END_STONE) || state.is(Blocks.SOUL_SAND) || state.is(Blocks.SOUL_SOIL)
                || state.is(Blocks.SNOW_BLOCK) || state.is(Blocks.PACKED_ICE) || state.is(Blocks.BLUE_ICE);
    }
}
