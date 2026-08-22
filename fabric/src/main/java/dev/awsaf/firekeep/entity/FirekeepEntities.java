package dev.awsaf.firekeep.entity;

import dev.awsaf.firekeep.Firekeep;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.MobCategory;
import net.minecraft.world.phys.Vec3;

public final class FirekeepEntities {
    public static final ResourceKey<EntityType<?>> DRONE_KEY =
            ResourceKey.create(Registries.ENTITY_TYPE, Firekeep.id("drone"));

    public static final EntityType<DroneEntity> DRONE = Registry.register(
            BuiltInRegistries.ENTITY_TYPE,
            DRONE_KEY,
            EntityType.Builder.of(DroneEntity::new, MobCategory.MISC)
                    .sized(0.9F, 0.5F)
                    // Camera height: the gimbal hangs just under the body.
                    .eyeHeight(0.22F)
                    .fireImmune()
                    .noLootTable()
                    // Drones are filmed from far away and must not stutter, so track them
                    // generously and send an update every tick.
                    .clientTrackingRange(16)
                    .updateInterval(1)
                    .build(DRONE_KEY));

    private FirekeepEntities() {
    }

    /** Spawns a drone hovering at {@code position}, facing {@code yaw}. */
    public static DroneEntity spawn(ServerLevel level, Vec3 position, float yaw) {
        DroneEntity drone = DRONE.create(level, EntitySpawnReason.COMMAND);
        if (drone == null) {
            return null;
        }

        drone.setPos(position);
        drone.setYRot(yaw);
        drone.setLook(yaw, 0.0F);
        drone.setOldPosAndRot();
        level.addFreshEntity(drone);
        return drone;
    }

    /** Forces class loading, which runs the registrations above. */
    public static void initialize() {
    }
}
