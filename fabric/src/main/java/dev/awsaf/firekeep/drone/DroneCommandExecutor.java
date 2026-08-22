package dev.awsaf.firekeep.drone;

import com.google.gson.JsonObject;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * The one door commands come in through.
 *
 * <p>It exists so that "run this order on that drone" is a single call with a single set of rules,
 * no matter who is asking - the HTTP API today, a Brigadier command or a dashboard button
 * tomorrow. Parsing, the does-this-drone-exist check, the queueing and the optional wait all live
 * here rather than being re-implemented per caller.
 *
 * <p>The distinction it enforces is the important one in this whole design: n8n names a goal, and
 * everything past {@link DroneManager#submit} is the mod's own business.
 */
public final class DroneCommandExecutor {
    /** Longest any caller may block on a drone finishing. */
    public static final long MAX_WAIT_MILLIS = 120_000L;
    public static final long DEFAULT_WAIT_MILLIS = 30_000L;

    private DroneCommandExecutor() {
    }

    /** Thrown when the request itself is wrong, as opposed to the drone failing to carry it out. */
    public static final class RejectedException extends RuntimeException {
        private final int status;

        RejectedException(int status, String message) {
            super(message);
            this.status = status;
        }

        public int status() {
            return this.status;
        }
    }

    /**
     * Validates {@code body} against {@code droneId} and queues it.
     *
     * @throws RejectedException 404 if there is no such drone, 400 if the order is malformed
     */
    public static DroneCommand submit(String droneId, JsonObject body) {
        if (DroneManager.state(droneId) == null) {
            throw new RejectedException(404, "no drone called '" + droneId + "'");
        }
        DroneCommand command;
        try {
            command = DroneCommand.parse(droneId, body);
        } catch (IllegalArgumentException e) {
            throw new RejectedException(400, e.getMessage());
        }
        DroneManager.submit(command);
        return command;
    }

    /**
     * Queues an order and waits for the drone to finish it.
     *
     * <p>A timeout is not a failure: the drone is still flying, and the caller is told to poll
     * rather than being handed a result that would be a lie.
     */
    public static CommandResult submitAndWait(String droneId, JsonObject body, long timeoutMillis) {
        DroneCommand command = submit(droneId, body);
        return await(command, timeoutMillis);
    }

    public static CommandResult await(DroneCommand command, long timeoutMillis) {
        long timeout = Math.min(MAX_WAIT_MILLIS, Math.max(100L, timeoutMillis));
        CompletableFuture<CommandResult> completion = command.completion();
        try {
            return completion.get(timeout, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            return new CommandResult(command.id(), command.droneId(), command.type().label(), true,
                    "running", "still running after " + timeout + "ms; poll GET /api/drones/"
                    + command.droneId() + "/command", null);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return CommandResult.failed(command, "interrupted while waiting");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            return CommandResult.failed(command, cause == null ? e.toString() : String.valueOf(cause.getMessage()));
        }
    }

    /** How long the caller asked to wait, from either the query string or the body. */
    public static long timeoutFrom(JsonObject body) {
        if (body != null && body.has("timeout_ms")) {
            try {
                return body.get("timeout_ms").getAsLong();
            } catch (RuntimeException e) {
                throw new RejectedException(400, "\"timeout_ms\" must be a number");
            }
        }
        return DEFAULT_WAIT_MILLIS;
    }
}
