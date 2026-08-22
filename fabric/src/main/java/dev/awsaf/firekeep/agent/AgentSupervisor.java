package dev.awsaf.firekeep.agent;

import dev.awsaf.firekeep.Firekeep;
import dev.awsaf.firekeep.entity.DroneEntity;
import dev.awsaf.firekeep.entity.FirekeepEntities;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;

import java.io.File;
import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Starts and stops rendering agents so the fleet looks after itself.
 *
 * <p>The server already knows which drones exist, so it is the right place to own the client
 * processes that film them: a labelled drone appears, an agent is launched for it, and when the
 * drone goes the agent is shut down. Agents bind to their drone by username, so nothing here has
 * to talk to the client beyond starting it.
 *
 * <p>Every agent is a real Minecraft client with a GPU context, so this only works on a machine
 * with a display, and only for as many instances as that machine can hold - {@code maxAgents} is
 * the guard.
 */
public final class AgentSupervisor {
    /** Reconciling every tick would be wasteful; drones do not come and go that fast. */
    private static final int RECONCILE_INTERVAL_TICKS = 40;

    private static final Map<String, Agent> AGENTS = new LinkedHashMap<>();

    private static AgentLaunchConfig config = null;
    private static int tickCounter;

    private AgentSupervisor() {
    }

    private static final class Agent {
        private final String droneId;
        private final int port;
        private Process process;
        private long restartAfter;
        private int launches;

        private Agent(String droneId, int port) {
            this.droneId = droneId;
            this.port = port;
        }

        private boolean isRunning() {
            return this.process != null && this.process.isAlive();
        }
    }

    public static void initialize() {
        ServerLifecycleEvents.SERVER_STARTED.register(server -> {
            config = AgentLaunchConfig.load();
            if (config.isUsable()) {
                Firekeep.LOGGER.info("agent supervisor ready, up to {} agents", config.maxAgents);
            }
        });
        ServerTickEvents.END_SERVER_TICK.register(AgentSupervisor::tick);
        // Agents are children of this server; leaving them running would orphan GPU processes.
        ServerLifecycleEvents.SERVER_STOPPING.register(server -> shutdownAll());
    }

    /** Launches an agent for {@code droneId} if there is not one already. */
    public static String deploy(String droneId) {
        if (config == null || !config.isUsable()) {
            return "Agent launching is not configured; fill in config/firekeep-agents.json";
        }
        Agent existing = AGENTS.get(droneId);
        if (existing != null && existing.isRunning()) {
            return "Agent for " + droneId + " is already running";
        }
        if (AGENTS.size() >= config.maxAgents && existing == null) {
            return "Already at maxAgents (" + config.maxAgents + ")";
        }

        Agent agent = existing != null ? existing : new Agent(droneId, nextPort());
        AGENTS.put(droneId, agent);
        return start(agent) ? "Launched an agent for " + droneId : "Could not launch an agent for " + droneId;
    }

    /** Stops the agent filming {@code droneId}. */
    public static String undeploy(String droneId) {
        Agent agent = AGENTS.remove(droneId);
        if (agent == null) {
            return "No agent for " + droneId;
        }
        stop(agent);
        return "Stopped the agent for " + droneId;
    }

    /** One agent as the dashboard needs to see it. */
    public record AgentInfo(String droneId, int port, boolean running) {
    }

    /** The droneId to port mapping the dashboard fans out across. */
    public static List<AgentInfo> directory() {
        List<AgentInfo> agents = new ArrayList<>();
        for (Agent agent : AGENTS.values()) {
            agents.add(new AgentInfo(agent.droneId, agent.port, agent.isRunning()));
        }
        return agents;
    }

    public static List<String> status() {
        List<String> lines = new ArrayList<>();
        if (config == null || !config.isUsable()) {
            lines.add("agent launching is not configured");
            return lines;
        }
        if (AGENTS.isEmpty()) {
            lines.add("no agents deployed");
            return lines;
        }
        for (Agent agent : AGENTS.values()) {
            lines.add(agent.droneId + " port " + agent.port
                    + (agent.isRunning() ? " running" : " stopped")
                    + " (" + agent.launches + " launches)");
        }
        return lines;
    }

    private static void tick(MinecraftServer server) {
        if (config == null || !config.isUsable()) {
            return;
        }
        if (++tickCounter < RECONCILE_INTERVAL_TICKS) {
            return;
        }
        tickCounter = 0;
        reconcile(server);
    }

    /** Brings the running agents in line with the drones that actually exist. */
    private static void reconcile(MinecraftServer server) {
        Set<String> droneIds = labelledDrones(server);

        // A drone that went away does not need filming any more.
        for (String droneId : new ArrayList<>(AGENTS.keySet())) {
            if (!droneIds.contains(droneId)) {
                Firekeep.LOGGER.info("drone {} is gone; stopping its agent", droneId);
                undeploy(droneId);
            }
        }

        long now = System.currentTimeMillis();
        for (Agent agent : AGENTS.values()) {
            if (agent.isRunning() || agent.restartAfter == 0L || now < agent.restartAfter) {
                continue;
            }
            // The client died on its own - a crash, or somebody closed it. Bring it back.
            Firekeep.LOGGER.info("agent for {} exited; restarting", agent.droneId);
            start(agent);
        }

        if (!config.auto) {
            return;
        }
        for (String droneId : droneIds) {
            if (!AGENTS.containsKey(droneId) && AGENTS.size() < config.maxAgents) {
                Firekeep.LOGGER.info("drone {} has no agent; deploying one", droneId);
                deploy(droneId);
            }
        }
    }

    private static Set<String> labelledDrones(MinecraftServer server) {
        Set<String> ids = new HashSet<>();
        for (ServerLevel level : server.getAllLevels()) {
            for (DroneEntity drone : level.getEntities(FirekeepEntities.DRONE, drone -> !drone.isRemoved())) {
                String id = drone.getDroneId();
                if (!id.isBlank()) {
                    ids.add(id);
                }
            }
        }
        return ids;
    }

    private static boolean start(Agent agent) {
        String username = DroneAgents.NAME_PREFIX + agent.droneId;
        Path gameDir = Path.of(fill(config.gameDir, agent, username)).toAbsolutePath();

        List<String> command = new ArrayList<>(config.command.size() + 1);
        for (String part : config.command) {
            command.add(fill(part, agent, username).replace("{gameDir}", gameDir.toString()));
        }
        addMods(command);

        try {
            Files.createDirectories(gameDir);
            seedOptions(gameDir);
            ProcessBuilder builder = new ProcessBuilder(command);
            builder.directory(gameDir.toFile());
            // The agent renders nothing anybody can see, so its log is the only way to debug it.
            File log = gameDir.resolve("agent.log").toFile();
            builder.redirectErrorStream(true);
            builder.redirectOutput(ProcessBuilder.Redirect.to(log));

            agent.process = builder.start();
            agent.launches++;
            agent.restartAfter = 0L;
            agent.process.onExit().thenRun(() ->
                    agent.restartAfter = System.currentTimeMillis() + config.restartDelaySeconds * 1000L);

            Firekeep.LOGGER.info("launched agent {} for drone {} on port {} (log: {})",
                    username, agent.droneId, agent.port, log);
            return true;
        } catch (IOException e) {
            Firekeep.LOGGER.error("could not launch an agent for {}: {}", agent.droneId, e.toString());
            agent.restartAfter = System.currentTimeMillis() + config.restartDelaySeconds * 1000L;
            return false;
        }
    }

    /**
     * Hands the agent's loader the renderer mods listed in the config.
     *
     * <p>Twelve Minecraft clients on one GPU is only affordable if each one renders cheaply, which
     * is what Sodium and Nvidium are here for. Neither is a dependency of this mod - they are
     * loose jars the operator drops in - so they are added at launch through loader's
     * {@code fabric.addMods}, the one hook that takes a jar the classpath knows nothing about.
     *
     * <p>The property is inserted straight after the java executable so it lands among the JVM
     * arguments; anything appended to the end of the command would be a game argument instead.
     * A jar that is not where the config says is dropped with a warning: an agent that renders
     * the slow way still films its drone.
     */
    private static void addMods(List<String> command) {
        if (config.mods.isEmpty() || command.isEmpty()) {
            return;
        }
        Path base = FabricLoader.getInstance().getGameDir();
        List<String> jars = new ArrayList<>(config.mods.size());
        for (String entry : config.mods) {
            Path jar = base.resolve(entry).toAbsolutePath().normalize();
            if (Files.isRegularFile(jar)) {
                jars.add(jar.toString());
            } else {
                Firekeep.LOGGER.warn("agent mod {} is not there; agents will run without it", jar);
            }
        }
        if (jars.isEmpty()) {
            return;
        }
        command.add(1, "-Dfabric.addMods=" + String.join(File.pathSeparator, jars));
        Firekeep.LOGGER.info("agents will load {} extra mod(s): {}", jars.size(), jars);
    }

    /**
     * Writes the two options a fresh game directory must have before an agent can run unattended.
     *
     * <p>{@code onboardAccessibility} is the important one: on a game directory that has never been
     * used, Minecraft opens the accessibility onboarding screen and waits for somebody to click
     * Continue. An agent has nobody to click it, so it sits there forever - loaded, rendering, and
     * never connecting, with nothing in the log to say why.
     *
     * <p>{@code pauseOnLostFocus} matters because an agent's window is hidden and so never focused.
     *
     * <p>{@code enableVsync} is off because a dozen clients each waiting on the same display's
     * refresh would serialise the whole fleet behind one monitor, and the render distance is cut
     * right down: an agent only ever films the few chunks around its own drone.
     *
     * <p>Only written when there is no options.txt yet; Minecraft fills in every other default and
     * rewrites the file itself on first run.
     */
    private static void seedOptions(Path gameDir) throws IOException {
        Path options = gameDir.resolve("options.txt");
        if (Files.exists(options)) {
            return;
        }
        Files.write(options,
                List.of("onboardAccessibility:false", "pauseOnLostFocus:false",
                        "enableVsync:false", "renderDistance:8", "simulationDistance:5"),
                StandardCharsets.UTF_8);
        Firekeep.LOGGER.info("seeded options.txt for a new agent game directory at {}", gameDir);
    }

    private static void stop(Agent agent) {
        if (agent.process == null) {
            return;
        }
        agent.process.destroy();
        agent.process = null;
        agent.restartAfter = 0L;
    }

    private static void shutdownAll() {
        for (Agent agent : AGENTS.values()) {
            stop(agent);
        }
        AGENTS.clear();
    }

    /**
     * Ports are handed out in order and kept for as long as the agent exists.
     * A previous server instance can leave a client alive for a few seconds (or be stopped
     * outside this JVM), so the supervisor must not assume that its in-memory directory is the
     * whole machine. Starting a client on an occupied port otherwise looks successful until its
     * camera server fails to bind and the dashboard gets a permanent 502.
     */
    private static int nextPort() {
        int port = config.portBase;
        Set<Integer> taken = new HashSet<>();
        AGENTS.values().forEach(agent -> taken.add(agent.port));
        while (taken.contains(port) || !portAvailable(port)) {
            port++;
        }
        return port;
    }

    private static boolean portAvailable(int port) {
        try (ServerSocket probe = new ServerSocket(port, 1, InetAddress.getLoopbackAddress())) {
            probe.setReuseAddress(true);
            return true;
        } catch (IOException ignored) {
            return false;
        }
    }

    private static String fill(String template, Agent agent, String username) {
        return template
                .replace("{droneId}", agent.droneId)
                .replace("{username}", username)
                .replace("{port}", Integer.toString(agent.port));
    }
}
