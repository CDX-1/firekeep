package dev.awsaf.firekeep.client.render;

import net.minecraft.client.model.EntityModel;
import net.minecraft.client.model.geom.ModelPart;
import net.minecraft.client.model.geom.PartPose;
import net.minecraft.client.model.geom.builders.CubeListBuilder;
import net.minecraft.client.model.geom.builders.LayerDefinition;
import net.minecraft.client.model.geom.builders.MeshDefinition;
import net.minecraft.client.model.geom.builders.PartDefinition;

/**
 * A quadcopter: a flat body with a camera gimbal underneath, four diagonal arms, and a
 * counter-rotating rotor on each arm.
 *
 * <p>Model space is the usual entity convention, +Y pointing down, so the renderer flips it.
 */
public class DroneModel extends EntityModel<DroneRenderState> {
    public static final int TEXTURE_WIDTH = 64;
    public static final int TEXTURE_HEIGHT = 32;

    private static final String BODY = "body";
    private static final String CAMERA = "camera";
    private static final String ROTOR = "rotor";
    private static final String[] ARMS = {"arm_front_right", "arm_front_left", "arm_back_left", "arm_back_right"};
    /** Arm bearings, evenly spaced and offset so no arm points straight down the camera axis. */
    private static final float[] ARM_ANGLES = {45.0F, 135.0F, 225.0F, 315.0F};

    private static final float DEG_TO_RAD = (float) Math.PI / 180.0F;

    private final ModelPart body;
    private final ModelPart[] rotors = new ModelPart[ARMS.length];

    public DroneModel(ModelPart root) {
        super(root);
        this.body = root.getChild(BODY);
        for (int i = 0; i < ARMS.length; i++) {
            this.rotors[i] = root.getChild(ARMS[i]).getChild(ROTOR);
        }
    }

    public static LayerDefinition createBodyLayer() {
        MeshDefinition mesh = new MeshDefinition();
        PartDefinition root = mesh.getRoot();

        PartDefinition body = root.addOrReplaceChild(BODY,
                CubeListBuilder.create().texOffs(0, 0).addBox(-3.0F, -1.0F, -3.0F, 6, 2, 6),
                PartPose.ZERO);

        body.addOrReplaceChild(CAMERA,
                CubeListBuilder.create().texOffs(0, 10).addBox(-1.5F, 0.0F, -1.5F, 3, 2, 3),
                PartPose.offset(0.0F, 1.0F, 0.0F));

        // Landing legs, one under each body corner.
        int leg = 0;
        for (float x = -2.5F; x <= 2.5F; x += 5.0F) {
            for (float z = -2.5F; z <= 2.5F; z += 5.0F) {
                body.addOrReplaceChild("leg_" + leg++,
                        CubeListBuilder.create().texOffs(0, 17).addBox(-0.5F, 0.0F, -0.5F, 1, 3, 1),
                        PartPose.offset(x, 1.0F, z));
            }
        }

        for (int i = 0; i < ARMS.length; i++) {
            PartDefinition arm = root.addOrReplaceChild(ARMS[i],
                    CubeListBuilder.create().texOffs(28, 0).addBox(1.0F, -0.5F, -0.5F, 5, 1, 1),
                    PartPose.rotation(0.0F, ARM_ANGLES[i] * DEG_TO_RAD, 0.0F));

            arm.addOrReplaceChild(ROTOR,
                    CubeListBuilder.create()
                            .texOffs(28, 4).addBox(-3.5F, -0.5F, -0.5F, 7, 1, 1)
                            .texOffs(28, 8).addBox(-0.5F, -0.5F, -3.5F, 1, 1, 7),
                    PartPose.offset(6.0F, -1.5F, 0.0F));
        }

        return LayerDefinition.create(mesh, TEXTURE_WIDTH, TEXTURE_HEIGHT);
    }

    @Override
    public void setupAnim(DroneRenderState state) {
        super.setupAnim(state);

        this.body.getChild(CAMERA).xRot = state.cameraPitch * DEG_TO_RAD;

        this.root().xRot = state.tiltForward * DEG_TO_RAD;
        this.root().zRot = state.tiltSideways * DEG_TO_RAD;

        for (int i = 0; i < this.rotors.length; i++) {
            // Adjacent rotors spin opposite ways, as on a real quadcopter.
            float direction = (i % 2 == 0) ? 1.0F : -1.0F;
            this.rotors[i].yRot = state.rotorAngle * DEG_TO_RAD * direction;
        }
    }
}
