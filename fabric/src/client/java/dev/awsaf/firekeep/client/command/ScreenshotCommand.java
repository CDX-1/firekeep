package dev.awsaf.firekeep.client.command;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.StringArgumentType;
import dev.awsaf.firekeep.Firekeep;
import dev.awsaf.firekeep.client.capture.CaptureClient;
import dev.awsaf.firekeep.client.capture.FrameGrabber;
import net.fabricmc.fabric.api.client.command.v2.ClientCommands;
import net.fabricmc.fabric.api.client.command.v2.FabricClientCommandSource;
import net.minecraft.ChatFormatting;
import net.minecraft.client.Minecraft;
import net.minecraft.commands.SharedSuggestionProvider;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;

import java.io.IOException;
import java.net.URI;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * {@code /screenshot} - grab the current frame, hand it to the python capture server, and follow
 * the Marble generation through to the PNG that lands back on disk.
 *
 * <pre>
 * /screenshot                          capture with the server's default model and prompt
 * /screenshot &lt;prompt...&gt;              capture with your own style guidance
 * /screenshot model &lt;model&gt; [&lt;prompt&gt;] capture on a specific Marble model
 * /screenshot status                   server health, credits, queue depth
 * /screenshot server [&lt;url&gt;]           show or change where captures are sent
 * </pre>
 */
public final class ScreenshotCommand {
    /** How long a Marble generation is allowed to take before we stop watching it. */
    private static final long POLL_TIMEOUT_MILLIS = 15 * 60 * 1000L;
    private static final long POLL_INTERVAL_MILLIS = 2000L;

    /**
     * Marble models, cheapest first. Draft is the server default because captures can fire
     * automatically, but it is also the one that clings hardest to the blocky input - if a scene
     * comes back looking like smoother Minecraft, that is the knob to turn.
     */
    private static final String[] MODELS = {
            "marble-1.0-draft", "marble-1.0", "marble-1.1", "marble-1.1-plus"
    };

    /** One capture at a time: the HUD is hidden for the duration, and worlds are not cheap. */
    private static final AtomicBoolean BUSY = new AtomicBoolean();

    private static final Executor NETWORK = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "firekeep-capture");
        thread.setDaemon(true);
        return thread;
    });

    private ScreenshotCommand() {
    }

    public static void register(CommandDispatcher<FabricClientCommandSource> dispatcher) {
        dispatcher.register(ClientCommands.literal("screenshot")
                .executes(ctx -> capture(ctx.getSource(), null, null))
                .then(ClientCommands.literal("model")
                        .then(ClientCommands.argument("model", StringArgumentType.word())
                                .suggests((ctx, builder) -> SharedSuggestionProvider.suggest(MODELS, builder))
                                .executes(ctx -> capture(ctx.getSource(), null,
                                        StringArgumentType.getString(ctx, "model")))
                                .then(ClientCommands.argument("prompt", StringArgumentType.greedyString())
                                        .executes(ctx -> capture(ctx.getSource(),
                                                StringArgumentType.getString(ctx, "prompt"),
                                                StringArgumentType.getString(ctx, "model"))))))
                .then(ClientCommands.literal("status")
                        .executes(ctx -> status(ctx.getSource())))
                .then(ClientCommands.literal("server")
                        .executes(ctx -> {
                            feedback(ctx.getSource(), "Captures go to " + CaptureClient.baseUrl());
                            return 1;
                        })
                        .then(ClientCommands.argument("url", StringArgumentType.greedyString())
                                .executes(ctx -> setServer(ctx.getSource(),
                                        StringArgumentType.getString(ctx, "url")))))
                .then(ClientCommands.argument("prompt", StringArgumentType.greedyString())
                        .executes(ctx -> capture(ctx.getSource(),
                                StringArgumentType.getString(ctx, "prompt"), null))));
    }

    private static int setServer(FabricClientCommandSource source, String url) {
        try {
            CaptureClient.setBaseUrl(url);
        } catch (IllegalArgumentException e) {
            error(source, e.getMessage());
            return 0;
        }
        feedback(source, "Captures now go to " + CaptureClient.baseUrl());
        return 1;
    }

    private static int status(FabricClientCommandSource source) {
        CompletableFuture.runAsync(() -> {
            try {
                JsonObject health = CaptureClient.health();
                StringBuilder line = new StringBuilder(CaptureClient.baseUrl()).append(" - ");
                if (bool(health, "dry_run")) {
                    line.append("dry run, nothing is generated");
                } else {
                    line.append("model ").append(string(health, "model", "?"))
                            .append(", ").append(string(health, "credits", "?")).append(" credits");
                }
                line.append(" - ").append(string(health, "queued", "0")).append(" queued, ")
                        .append(string(health, "busy", "0")).append(" running");
                feedback(source, line.toString());
            } catch (IOException e) {
                error(source, e.getMessage());
            }
        }, NETWORK);
        return 1;
    }

    private static int capture(FabricClientCommandSource source, String prompt, String model) {
        if (!BUSY.compareAndSet(false, true)) {
            error(source, "A capture is already running. Try /screenshot status.");
            return 0;
        }

        feedback(source, "Capturing...");
        FrameGrabber.grab(true).whenCompleteAsync((png, error) -> {
            try {
                if (error != null) {
                    error(source, "Could not grab the frame: " + rootMessage(error));
                    return;
                }
                run(source, png, prompt, model);
            } finally {
                BUSY.set(false);
            }
        }, NETWORK);
        return 1;
    }

    /** Submit the frame and follow the job until it lands. Runs on {@link #NETWORK}. */
    private static void run(FabricClientCommandSource source, byte[] png, String prompt, String model) {
        String jobId;
        try {
            jobId = CaptureClient.submit(png, prompt, model);
        } catch (IOException e) {
            error(source, e.getMessage());
            return;
        }

        feedback(source, String.format("Sent %.1f MB to World Labs - job %s", png.length / 1e6, jobId));

        long deadline = System.currentTimeMillis() + POLL_TIMEOUT_MILLIS;
        String lastNote = "";
        while (System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(POLL_INTERVAL_MILLIS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }

            JsonObject job;
            try {
                job = CaptureClient.job(jobId);
            } catch (IOException e) {
                error(source, "Lost the capture server: " + e.getMessage());
                return;
            }

            String status = string(job, "status", "unknown");
            if (status.equals("done")) {
                announce(source, job);
                return;
            }
            if (status.equals("failed")) {
                error(source, "Generation failed: " + string(job, "error", "no reason given"));
                return;
            }

            String note = status + (job.get("progress") == null || job.get("progress").isJsonNull()
                    ? "" : " " + string(job, "progress", "") + "%");
            if (!note.equals(lastNote)) {
                lastNote = note;
                feedback(source, "Job " + jobId + ": " + note);
            }
        }
        error(source, "Gave up waiting on job " + jobId + " - it may still finish; /screenshot status");
    }

    private static void announce(FabricClientCommandSource source, JsonObject job) {
        String seconds = string(job, "took_seconds", "?");
        String path = string(job, "result_png", null);
        if (path == null) {
            feedback(source, "Done in " + seconds + "s, but the server produced no image");
        } else {
            feedback(source, "Done in " + seconds + "s -> " + path);
        }

        String worldUrl = string(job, "marble_url", null);
        if (worldUrl != null) {
            Minecraft.getInstance().execute(() -> source.sendFeedback(prefix()
                    .append(Component.literal("open the 3D world")
                            .withStyle(style -> style
                                    .withColor(ChatFormatting.AQUA)
                                    .withUnderlined(true)
                                    .withClickEvent(new ClickEvent.OpenUrl(URI.create(worldUrl)))))));
        }
        Firekeep.LOGGER.info("capture {} finished: {}", string(job, "id", "?"), path);
    }

    // -- chat ---------------------------------------------------------------

    private static void feedback(FabricClientCommandSource source, String message) {
        Minecraft.getInstance().execute(() -> source.sendFeedback(prefix()
                .append(Component.literal(message).withStyle(ChatFormatting.GRAY))));
    }

    private static void error(FabricClientCommandSource source, String message) {
        Firekeep.LOGGER.warn("capture: {}", message);
        Minecraft.getInstance().execute(() -> source.sendError(prefix()
                .append(Component.literal(message == null ? "unknown error" : message)
                        .withStyle(ChatFormatting.RED))));
    }

    private static MutableComponent prefix() {
        return Component.literal("[firekeep] ").withStyle(ChatFormatting.DARK_AQUA);
    }

    // -- json ---------------------------------------------------------------

    private static String string(JsonObject object, String key, String fallback) {
        JsonElement value = object.get(key);
        return value == null || value.isJsonNull() ? fallback : value.getAsString();
    }

    private static boolean bool(JsonObject object, String key) {
        JsonElement value = object.get(key);
        return value != null && !value.isJsonNull() && value.getAsBoolean();
    }

    private static String rootMessage(Throwable t) {
        Throwable cause = t;
        while (cause.getCause() != null) {
            cause = cause.getCause();
        }
        return cause.getMessage() == null ? cause.toString() : cause.getMessage();
    }
}
