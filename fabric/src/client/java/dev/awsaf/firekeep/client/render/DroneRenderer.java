package dev.awsaf.firekeep.client.render;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.math.Axis;
import dev.awsaf.firekeep.Firekeep;
import dev.awsaf.firekeep.entity.DroneEntity;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.client.renderer.entity.EntityRenderer;
import net.minecraft.client.renderer.entity.EntityRendererProvider;
import net.minecraft.client.renderer.state.level.CameraRenderState;
import net.minecraft.client.renderer.texture.OverlayTexture;
import net.minecraft.resources.Identifier;
import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;

public class DroneRenderer extends EntityRenderer<DroneEntity, DroneRenderState> {
    private static final Identifier TEXTURE = Firekeep.id("textures/entity/drone.png");

    /** Where the model sits inside the 0.5-block-tall hitbox. */
    private static final float MODEL_HEIGHT = 0.3F;
    /** Degrees of rotor spin per tick at full throttle. */
    private static final float ROTOR_DEGREES_PER_TICK = 90.0F;
    private static final float MAX_TILT_DEGREES = 18.0F;
    /** Velocity (blocks/tick) that produces the full tilt. */
    private static final float TILT_REFERENCE_SPEED = 0.4F;
    private static final float DEG_TO_RAD = (float) Math.PI / 180.0F;

    private final DroneModel model;

    public DroneRenderer(EntityRendererProvider.Context context) {
        super(context);
        this.model = new DroneModel(context.bakeLayer(FirekeepModelLayers.DRONE));
        this.shadowRadius = 0.4F;
        this.shadowStrength = 0.5F;
    }

    @Override
    public DroneRenderState createRenderState() {
        return new DroneRenderState();
    }

    @Override
    public void extractRenderState(DroneEntity drone, DroneRenderState state, float partialTick) {
        super.extractRenderState(drone, state, partialTick);

        state.yRot = drone.getYRot(partialTick);
        state.cameraPitch = drone.getXRot(partialTick);

        float age = drone.tickCount + partialTick;
        state.rotorAngle = (age * ROTOR_DEGREES_PER_TICK * drone.getRotorSpeed()) % 360.0F;
        state.bob = Mth.sin(age * 0.15F) * 0.015F;

        // Tilt into the direction of travel, the way a real quadcopter leans to accelerate.
        Vec3 velocity = drone.getDeltaMovement();
        float yawRad = state.yRot * DEG_TO_RAD;
        float sin = Mth.sin(yawRad);
        float cos = Mth.cos(yawRad);
        double forward = velocity.x * -sin + velocity.z * cos;
        double sideways = velocity.x * cos + velocity.z * sin;
        state.tiltForward = tiltFor(forward);
        state.tiltSideways = tiltFor(sideways);
    }

    private static float tiltFor(double speedComponent) {
        float normalized = (float) (speedComponent / TILT_REFERENCE_SPEED);
        return Mth.clamp(normalized, -1.0F, 1.0F) * MAX_TILT_DEGREES;
    }

    @Override
    public void submit(DroneRenderState state, PoseStack poseStack, SubmitNodeCollector collector,
                       CameraRenderState cameraRenderState) {
        poseStack.pushPose();
        poseStack.translate(0.0F, MODEL_HEIGHT + state.bob, 0.0F);
        poseStack.mulPose(Axis.YP.rotationDegrees(180.0F - state.yRot));
        // Entity models are authored upside down relative to the world.
        poseStack.scale(-1.0F, -1.0F, 1.0F);

        collector.submitModel(this.model, state, poseStack, TEXTURE, state.lightCoords,
                OverlayTexture.NO_OVERLAY, state.outlineColor, null);

        poseStack.popPose();
        super.submit(state, poseStack, collector, cameraRenderState);
    }
}
