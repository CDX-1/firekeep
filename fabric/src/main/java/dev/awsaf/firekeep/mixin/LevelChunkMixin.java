package dev.awsaf.firekeep.mixin;

import dev.awsaf.firekeep.live.WorldFeed;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * The one hook the live map needs: every block that changes anywhere on the server passes
 * through here, fire spreading and blocks burning away included.
 *
 * <p>Deliberately does almost nothing - {@link WorldFeed#markDirty} is a set insert. All the
 * sampling and sending happens later, off this call path.
 */
@Mixin(LevelChunk.class)
public class LevelChunkMixin {

    @Inject(method = "setBlockState", at = @At("RETURN"))
    private void firekeep$noteSurfaceChange(BlockPos pos, BlockState state, int flags,
                                            CallbackInfoReturnable<BlockState> info) {
        if (info.getReturnValue() == null) {
            return;                                  // the set was a no-op
        }
        LevelChunk self = (LevelChunk) (Object) this;
        if (self.getLevel() instanceof ServerLevel level) {
            WorldFeed.markDirty(level, pos.getX(), pos.getZ());
        }
    }
}
