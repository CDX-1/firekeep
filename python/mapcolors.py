"""
Block name -> map colour, following vanilla's MapColor palette.

Exact names win; anything unmatched falls through the suffix rules at the bottom,
which is what keeps the map readable on a world full of blocks we never listed.
"""

# the vanilla MapColor base colours, by the name the game gives them
BASE = {
    "none": 0x000000, "grass": 0x7FB238, "sand": 0xF7E9A3, "wool": 0xC7C7C7,
    "fire": 0xFF0000, "ice": 0xA0A0FF, "metal": 0xA7A7A7, "plant": 0x007C00,
    "snow": 0xFFFFFF, "clay": 0xA4A8B8, "dirt": 0x976D4D, "stone": 0x707070,
    "water": 0x4040FF, "wood": 0x8F7748, "quartz": 0xFFFCF5,
    "orange": 0xD87F33, "magenta": 0xB24CD8, "light_blue": 0x6699D8,
    "yellow": 0xE5E533, "light_green": 0x7FCC19, "pink": 0xF27FA5,
    "gray": 0x4C4C4C, "light_gray": 0x999999, "cyan": 0x4C7F99,
    "purple": 0x7F3FB2, "blue": 0x334CB2, "brown": 0x664C33, "green": 0x667F33,
    "red": 0x993333, "black": 0x191919, "gold": 0xFAEE4D, "diamond": 0x5CDBD5,
    "lapis": 0x4A80FF, "emerald": 0x00D93A, "podzol": 0x815631,
    "nether": 0x700200, "terracotta_white": 0xD1B1A1, "terracotta_orange": 0x9F5224,
    "terracotta_magenta": 0x95576C, "terracotta_light_blue": 0x706C8A,
    "terracotta_yellow": 0xBA8524, "terracotta_light_green": 0x677535,
    "terracotta_pink": 0xB36B5C, "terracotta_gray": 0x392923,
    "terracotta_light_gray": 0x876B62, "terracotta_cyan": 0x575C5C,
    "terracotta_purple": 0x7A4958, "terracotta_blue": 0x4C3E5C,
    "terracotta_brown": 0x4C3223, "terracotta_green": 0x4F5522,
    "terracotta_red": 0x8E3C2E, "terracotta_black": 0x251610,
    "crimson_nylium": 0xBD3031, "crimson_stem": 0x943F61,
    "crimson_hyphae": 0x5C191D, "warped_nylium": 0x167E86,
    "warped_stem": 0x3A8E8C, "warped_hyphae": 0x562C3E,
    "warped_wart": 0x14B485, "deepslate": 0x646464, "raw_iron": 0xD8AF93,
    "glow_lichen": 0x7FA796,
}

# blocks whose colour is not guessable from the name
EXACT = {
    "air": "none", "cave_air": "none", "void_air": "none",
    "water": "water", "bubble_column": "water", "flowing_water": "water",
    "lava": "fire", "flowing_lava": "fire", "magma_block": "nether",
    "grass_block": "grass", "short_grass": "plant", "tall_grass": "plant",
    "fern": "plant", "large_fern": "plant", "moss_block": "plant",
    "moss_carpet": "plant", "vine": "plant", "sugar_cane": "plant",
    "lily_pad": "plant", "seagrass": "water", "tall_seagrass": "water",
    "kelp": "water", "kelp_plant": "water", "cactus": "plant",
    "bamboo": "plant", "azalea": "plant", "flowering_azalea": "plant",
    "dirt": "dirt", "coarse_dirt": "dirt", "rooted_dirt": "dirt",
    "farmland": "dirt", "dirt_path": "dirt", "mud": "terracotta_cyan",
    "podzol": "podzol", "mycelium": "purple", "clay": "clay",
    "sand": "sand", "sandstone": "sand", "smooth_sandstone": "sand",
    "cut_sandstone": "sand", "chiseled_sandstone": "sand",
    "red_sand": "terracotta_orange", "red_sandstone": "terracotta_orange",
    "gravel": "stone", "stone": "stone", "cobblestone": "stone",
    "mossy_cobblestone": "stone", "andesite": "stone", "diorite": "quartz",
    "granite": "dirt", "tuff": "terracotta_gray", "calcite": "terracotta_white",
    "dripstone_block": "terracotta_brown", "bedrock": "stone",
    "obsidian": "black", "crying_obsidian": "black",
    "snow": "snow", "snow_block": "snow", "powder_snow": "snow",
    "ice": "ice", "packed_ice": "ice", "blue_ice": "ice", "frosted_ice": "ice",
    "netherrack": "nether", "soul_sand": "brown", "soul_soil": "brown",
    "glowstone": "sand", "sea_lantern": "quartz", "shroomlight": "orange",
    "iron_block": "metal", "gold_block": "gold", "diamond_block": "diamond",
    "emerald_block": "emerald", "lapis_block": "lapis",
    "redstone_block": "fire", "coal_block": "black",
    "raw_iron_block": "raw_iron", "raw_copper_block": "orange",
    "copper_block": "orange", "netherite_block": "black",
    "glass": "none", "tinted_glass": "none", "barrier": "none",
    "torch": "wood", "campfire": "podzol", "bell": "gold",
    "cobweb": "wool", "sponge": "yellow", "wet_sponge": "yellow",
    "melon": "light_green", "pumpkin": "orange", "carved_pumpkin": "orange",
    "jack_o_lantern": "orange", "hay_block": "yellow", "bone_block": "sand",
    "end_stone": "sand", "purpur_block": "magenta", "chorus_plant": "purple",
    "prismarine": "cyan", "dark_prismarine": "diamond",
    "nether_wart_block": "red", "warped_wart_block": "warped_wart",
    "crimson_nylium": "crimson_nylium", "warped_nylium": "warped_nylium",
    "sculk": "black", "sculk_vein": "black", "sculk_catalyst": "black",
    "amethyst_block": "purple", "budding_amethyst": "purple",
    "mud_bricks": "terracotta_light_gray", "packed_mud": "dirt",
    "bricks": "red", "nether_bricks": "nether", "chest": "wood",
    "crafting_table": "wood", "furnace": "stone", "bookshelf": "wood",
    "ladder": "wood", "scaffolding": "sand", "lantern": "metal",
    "soul_lantern": "metal", "soul_torch": "wood", "beacon": "diamond",
    "spawner": "stone", "cauldron": "stone", "anvil": "metal",
    "pointed_dripstone": "terracotta_brown", "big_dripleaf": "plant",
    "small_dripleaf": "plant", "hanging_roots": "dirt",
    "spore_blossom": "pink", "glow_lichen": "glow_lichen",
    "mangrove_roots": "wood", "muddy_mangrove_roots": "dirt",
    "pale_moss_block": "plant", "pale_hanging_moss": "plant",
}

# wood families: log/planks/leaves all key off the family name
WOODS = {
    "oak": ("wood", "plant"), "spruce": ("podzol", "plant"),
    "birch": ("sand", "plant"), "jungle": ("dirt", "plant"),
    "acacia": ("orange", "plant"), "dark_oak": ("brown", "plant"),
    "mangrove": ("red", "plant"), "cherry": ("terracotta_white", "pink"),
    "pale_oak": ("terracotta_white", "plant"), "bamboo": ("yellow", "plant"),
    "crimson": ("crimson_stem", "crimson_nylium"),
    "warped": ("warped_stem", "warped_nylium"),
}

# the 16 dye colours, for wool/concrete/terracotta/glass/etc.
DYES = ("white", "orange", "magenta", "light_blue", "yellow", "lime", "pink",
        "gray", "light_gray", "cyan", "purple", "blue", "brown", "green",
        "red", "black")
DYE_BASE = {"white": "wool", "lime": "light_green"}


def _dyed(name, suffix, terracotta=False):
    """Colour for `<dye>_<suffix>`, or None if the name is not one of those."""
    if not name.endswith(suffix):
        return None
    dye = name[: -len(suffix) - 1]
    if dye not in DYES:
        return None
    if terracotta:
        return BASE.get(f"terracotta_{dye}", BASE["terracotta_white"])
    return BASE.get(DYE_BASE.get(dye, dye), BASE["wool"])


def color(block_name):
    """Top-down map colour for a block id, with or without the namespace."""
    name = block_name.split(":", 1)[-1]

    exact = EXACT.get(name)
    if exact:
        return BASE[exact]

    for family, (solid, foliage) in WOODS.items():
        if not name.startswith(family + "_") and name != family:
            continue
        rest = name[len(family) + 1:]
        if "leaves" in rest or rest in ("sapling", "propagule"):
            return BASE[foliage]
        return BASE[solid]

    for suffix, terracotta in (("terracotta", True), ("glazed_terracotta", True),
                               ("wool", False), ("carpet", False), ("concrete", False),
                               ("concrete_powder", False), ("stained_glass", False),
                               ("shulker_box", False), ("bed", False), ("banner", False),
                               ("candle", False)):
        hit = _dyed(name, suffix, terracotta)
        if hit is not None:
            return hit

    if name == "terracotta":
        return BASE["terracotta_white"]
    if "deepslate" in name:
        return BASE["deepslate"]
    if "blackstone" in name or "basalt" in name:
        return BASE["black"]
    if "nether" in name:
        return BASE["nether"]
    if "sandstone" in name or "sand" in name:
        return BASE["sand"]
    if "prismarine" in name:
        return BASE["cyan"]
    if "quartz" in name or "diorite" in name:
        return BASE["quartz"]
    if "copper" in name:
        return BASE["orange"]
    if "ice" in name:
        return BASE["ice"]
    if "leaves" in name or "moss" in name or "grass" in name:
        return BASE["plant"]
    if "log" in name or "wood" in name or "plank" in name or "fence" in name:
        return BASE["wood"]
    if "brick" in name or "stone" in name or "cobbled" in name or "ore" in name:
        return BASE["stone"]
    if "flower" in name or "tulip" in name or "orchid" in name or "bush" in name:
        return BASE["plant"]

    return BASE["stone"]
