package dev.awsaf.firekeep.drone;

/**
 * The high-level verbs n8n is allowed to use. Anything finer-grained than this - headings,
 * waypoints, per-tick velocity - is the mod's job, not the model's.
 */
public enum CommandType {
    MOVE("move"),
    MOVE_TO("move_to"),
    HOVER("hover"),
    SCAN("scan"),
    RETURN_HOME("return_home"),
    FOLLOW("follow"),
    DISPENSE_WATER("dispense_water"),
    LOOK("look"),
    PATROL("patrol"),
    SET_SPEED("set_speed"),
    SET_HOME("set_home"),
    CANCEL("cancel");

    private final String label;

    CommandType(String label) {
        this.label = label;
    }

    public String label() {
        return this.label;
    }

    public static CommandType parse(String raw) {
        if (raw == null) {
            return null;
        }
        String key = raw.trim().toLowerCase().replace('-', '_').replace(' ', '_');
        for (CommandType type : values()) {
            if (type.label.equals(key)) {
                return type;
            }
        }
        return switch (key) {
            case "goto", "fly_to", "navigate" -> MOVE_TO;
            case "stop", "hold", "hold_position" -> HOVER;
            case "rtb", "go_home", "return" -> RETURN_HOME;
            case "extinguish", "drop_water", "water" -> DISPENSE_WATER;
            case "perceive", "look_around", "observe" -> SCAN;
            case "aim", "face" -> LOOK;
            default -> null;
        };
    }
}
