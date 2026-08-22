package dev.awsaf.firekeep.agent;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import dev.awsaf.firekeep.Firekeep;
import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * How to start a rendering agent, read from {@code config/firekeep-agents.json}.
 *
 * <p>The server cannot work out on its own how to launch a Minecraft client - a Loom dev run and a
 * packaged instance have completely different classpaths and arguments - so it takes a command
 * template and fills in the per-agent parts. Placeholders: {@code {droneId}}, {@code {username}},
 * {@code {port}}, {@code {gameDir}}.
 *
 * <p>{@code mods} is separate from {@code command} because the two are maintained differently: the
 * command is copied once from a working launch and left alone, while the renderer mods an agent
 * runs are something you change. The supervisor turns the list into loader's {@code fabric.addMods}
 * property rather than making you edit a classpath by hand.
 */
public final class AgentLaunchConfig {
    private static final String FILE_NAME = "firekeep-agents.json";
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    /**
     * How many agents may run at once when the config does not say.
     *
     * <p>Each agent is a whole Minecraft client, so this is really a statement about the machine.
     * Twelve is what the fleet is sized for now that drones can be placed from the dashboard;
     * a smaller box should say so in the config rather than rely on this.
     */
    private static final int DEFAULT_MAX_AGENTS = 12;

    /** Off until somebody fills in a command; an empty template can only fail. */
    public final boolean enabled;
    /** Deploy agents automatically as labelled drones appear, rather than only on command. */
    public final boolean auto;
    public final int maxAgents;
    public final int portBase;
    /** Working directory per agent; {@code {droneId}} is substituted. */
    public final String gameDir;
    /** Seconds to wait before restarting an agent that exited on its own. */
    public final int restartDelaySeconds;
    public final List<String> command;
    /**
     * Extra mod jars every agent loads, on top of what the command's classpath already has.
     *
     * <p>Paths are absolute, or relative to the server's own game directory. A jar that is not
     * there is skipped with a warning rather than failing the launch, since an agent that renders
     * slowly is worth more than one that does not start.
     */
    public final List<String> mods;

    private AgentLaunchConfig(boolean enabled, boolean auto, int maxAgents, int portBase,
                              String gameDir, int restartDelaySeconds, List<String> command,
                              List<String> mods) {
        this.enabled = enabled;
        this.auto = auto;
        this.maxAgents = maxAgents;
        this.portBase = portBase;
        this.gameDir = gameDir;
        this.restartDelaySeconds = restartDelaySeconds;
        this.command = List.copyOf(command);
        this.mods = List.copyOf(mods);
    }

    public boolean isUsable() {
        return this.enabled && !this.command.isEmpty();
    }

    /** Reads the config, writing a disabled template first if there is none. */
    public static AgentLaunchConfig load() {
        Path path = FabricLoader.getInstance().getConfigDir().resolve(FILE_NAME);
        if (!Files.exists(path)) {
            writeTemplate(path);
            return disabled();
        }
        try {
            String raw = Files.readString(path, StandardCharsets.UTF_8);
            JsonObject json = GSON.fromJson(raw, JsonObject.class);
            if (json == null) {
                return disabled();
            }

            return new AgentLaunchConfig(
                    bool(json, "enabled", false),
                    bool(json, "auto", true),
                    integer(json, "maxAgents", DEFAULT_MAX_AGENTS),
                    integer(json, "portBase", 8088),
                    string(json, "gameDir", "run-agent-{droneId}"),
                    integer(json, "restartDelaySeconds", 10),
                    strings(json, "command"),
                    strings(json, "mods"));
        } catch (Exception e) {
            Firekeep.LOGGER.error("could not read {}: {}", FILE_NAME, e.toString());
            return disabled();
        }
    }

    private static AgentLaunchConfig disabled() {
        return new AgentLaunchConfig(false, false, 0, 8088, "run-agent-{droneId}", 10,
                List.of(), List.of());
    }

    private static void writeTemplate(Path path) {
        JsonObject json = new JsonObject();
        json.addProperty("_comment", "Fill in \"command\" with the argv that starts one agent client, "
                + "then set enabled to true. Placeholders: {droneId} {username} {port} {gameDir}. "
                + "In a Loom dev run, copy the java command IntelliJ prints on the first line of the "
                + "Minecraft Client console and append the agent flags.");
        json.addProperty("enabled", false);
        json.addProperty("auto", true);
        json.addProperty("maxAgents", DEFAULT_MAX_AGENTS);
        json.addProperty("portBase", 8088);
        json.addProperty("gameDir", "run-agent-{droneId}");
        json.addProperty("restartDelaySeconds", 10);
        json.add("command", GSON.toJsonTree(List.of()));
        json.add("mods", GSON.toJsonTree(List.of()));

        try {
            Files.createDirectories(path.getParent());
            Files.writeString(path, GSON.toJson(json), StandardCharsets.UTF_8);
            Firekeep.LOGGER.info("wrote an agent launch template to {}", path);
        } catch (IOException e) {
            Firekeep.LOGGER.error("could not write {}: {}", FILE_NAME, e.toString());
        }
    }

    private static boolean bool(JsonObject json, String key, boolean fallback) {
        return json.has(key) ? json.get(key).getAsBoolean() : fallback;
    }

    private static int integer(JsonObject json, String key, int fallback) {
        return json.has(key) ? json.get(key).getAsInt() : fallback;
    }

    private static List<String> strings(JsonObject json, String key) {
        List<String> values = new ArrayList<>();
        if (json.has(key) && json.get(key).isJsonArray()) {
            json.getAsJsonArray(key).forEach(element -> values.add(element.getAsString()));
        }
        return values;
    }

    private static String string(JsonObject json, String key, String fallback) {
        return json.has(key) ? json.get(key).getAsString() : fallback;
    }
}
