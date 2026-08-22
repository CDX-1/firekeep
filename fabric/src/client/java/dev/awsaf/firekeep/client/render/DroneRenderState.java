package dev.awsaf.firekeep.client.render;

import net.minecraft.client.renderer.entity.state.EntityRenderState;

/** Everything the drone renderer needs, extracted once per frame off the entity. */
public class DroneRenderState extends EntityRenderState {
    public float yRot;
    /** Pitch of the camera gimbal, in degrees. */
    public float cameraPitch;
    /** Rotor rotation this frame, in degrees. */
    public float rotorAngle;
    /** Body tilt into the direction of travel, in degrees. */
    public float tiltForward;
    public float tiltSideways;
    /** Idle hover bob, in blocks. */
    public float bob;
}
