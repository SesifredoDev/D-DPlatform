// Trimmed Open5e v2 responses (api.open5e.com, fetched 2026-11-25) for statblock-import tests.
export const GOBLIN = {
 "key": "srd_goblin",
 "name": "Goblin",
 "type": {
  "name": "Humanoid",
  "key": "humanoid"
 },
 "size": {
  "name": "Small",
  "key": "small"
 },
 "alignment": "neutral evil",
 "armor_class": 15,
 "armor_detail": "leather armor, shield",
 "hit_points": 7,
 "hit_dice": "2d6",
 "speed": {
  "walk": 30,
  "unit": "feet"
 },
 "ability_scores": {
  "strength": 8,
  "dexterity": 14,
  "constitution": 10,
  "intelligence": 10,
  "wisdom": 8,
  "charisma": 8
 },
 "saving_throws": {},
 "skill_bonuses": {
  "stealth": 6
 },
 "resistances_and_immunities": {
  "damage_immunities_display": "",
  "damage_immunities": [],
  "damage_resistances_display": "",
  "damage_resistances": [],
  "damage_vulnerabilities_display": "",
  "damage_vulnerabilities": [],
  "condition_immunities_display": "",
  "condition_immunities": []
 },
 "normal_sight_range": 10560,
 "darkvision_range": 60,
 "blindsight_range": null,
 "passive_perception": 9,
 "languages": {
  "as_string": "Common, Goblin"
 },
 "challenge_rating": 0.25,
 "traits": [
  {
   "name": "Nimble Escape",
   "desc": "The goblin can take the Disengage or Hide action as a bonus action on each of its turns."
  }
 ],
 "actions": [
  {
   "name": "Scimitar",
   "desc": "Melee Weapon Attack: +4 to hit, reach 5 ft., one target. Hit: 5 (1d6 + 2) slashing damage.",
   "action_type": "ACTION",
   "order_in_statblock": 0,
   "legendary_action_cost": 1,
   "usage_limits": null
  },
  {
   "name": "Shortbow",
   "desc": "Ranged Weapon Attack: +4 to hit, range 80/320 ft., one target. Hit: 5 (1d6 + 2) piercing damage.",
   "action_type": "ACTION",
   "order_in_statblock": 1,
   "legendary_action_cost": 1,
   "usage_limits": null
  }
 ],
 "illustration": null,
 "document": {
  "name": "System Reference Document 5.1",
  "display_name": "5e 2014 Rules",
  "publisher": {
   "name": "Wizards of the Coast"
  }
 }
};

export const DRAGON = {
 "key": "srd_adult-red-dragon",
 "name": "Adult Red Dragon",
 "actions": [
  {
   "name": "Bite",
   "desc": "Melee Weapon Attack: +14 to hit, reach 1",
   "action_type": "ACTION",
   "order_in_statblock": 1,
   "legendary_action_cost": 1,
   "usage_limits": null
  },
  {
   "name": "Claw",
   "desc": "Melee Weapon Attack: +14 to hit, reach 5",
   "action_type": "ACTION",
   "order_in_statblock": 2,
   "legendary_action_cost": 1,
   "usage_limits": null
  },
  {
   "name": "Detect",
   "desc": "The dragon makes a Wisdom (Perception) c",
   "action_type": "LEGENDARY_ACTION",
   "order_in_statblock": 0,
   "legendary_action_cost": 1,
   "usage_limits": null
  },
  {
   "name": "Fire Breath",
   "desc": "The dragon exhales fire in a 60-foot con",
   "action_type": "ACTION",
   "order_in_statblock": 5,
   "legendary_action_cost": null,
   "usage_limits": {
    "type": "RECHARGE_ON_ROLL",
    "param": 5
   }
  },
  {
   "name": "Frightful Presence",
   "desc": "Each creature of the dragon's choice tha",
   "action_type": "ACTION",
   "order_in_statblock": 4,
   "legendary_action_cost": 1,
   "usage_limits": null
  },
  {
   "name": "Multiattack",
   "desc": "The dragon can use its Frightful Presenc",
   "action_type": "ACTION",
   "order_in_statblock": 0,
   "legendary_action_cost": 1,
   "usage_limits": null
  },
  {
   "name": "Tail",
   "desc": "Melee Weapon Attack: +14 to hit, reach 1",
   "action_type": "ACTION",
   "order_in_statblock": 3,
   "legendary_action_cost": 1,
   "usage_limits": null
  },
  {
   "name": "Tail Attack",
   "desc": "The dragon makes a tail attack.",
   "action_type": "LEGENDARY_ACTION",
   "order_in_statblock": 1,
   "legendary_action_cost": 1,
   "usage_limits": null
  },
  {
   "name": "Wing Attack",
   "desc": "The dragon beats its wings. Each creatur",
   "action_type": "LEGENDARY_ACTION",
   "order_in_statblock": 2,
   "legendary_action_cost": 2,
   "usage_limits": null
  }
 ],
 "saving_throws": {
  "dexterity": 6,
  "constitution": 13,
  "wisdom": 7,
  "charisma": 11
 },
 "skill_bonuses": {
  "perception": 13,
  "stealth": 6
 },
 "resistances_and_immunities": {
  "damage_immunities_display": "fire",
  "damage_immunities": [
   {
    "name": "Fire",
    "key": "fire"
   }
  ],
  "damage_resistances_display": "",
  "damage_resistances": [],
  "damage_vulnerabilities_display": "",
  "damage_vulnerabilities": [],
  "condition_immunities_display": "",
  "condition_immunities": []
 },
 "challenge_rating": 17.0,
 "speed": {
  "walk": 40,
  "unit": "feet",
  "fly": 80,
  "climb": 40
 }
};

export const FLAME_TONGUE = {
 "key": "srd_flame-tongue-longsword",
 "name": "Flame Tongue (Longsword)",
 "desc": "You can use a bonus action to speak this magic sword's command word, causing fla",
 "category": {
  "name": "Weapon",
  "key": "weapon"
 },
 "rarity": {
  "name": "Rare",
  "key": "rare",
  "rank": 3
 },
 "weapon": {
  "name": "Longsword",
  "key": "srd_longsword",
  "damage_type": {
   "name": "Slashing",
   "key": "slashing"
  },
  "damage_dice": "1d8",
  "properties": [
   {
    "property": {
     "name": "Versatile",
     "type": null,
     "desc": ""
    },
    "detail": "1d10"
   }
  ],
  "is_simple": false,
  "is_martial": true,
  "is_improvised": false,
  "distance_unit": "feet"
 },
 "armor": null,
 "weight": "3.000",
 "weight_unit": "lb",
 "cost": null,
 "requires_attunement": true,
 "attunement_detail": null
};

export const LONGSWORD = {
 "key": "srd_longsword",
 "name": "Longsword",
 "desc": "A longsword",
 "category": {
  "name": "Weapon",
  "key": "weapon"
 },
 "weapon": {
  "name": "Longsword",
  "key": "srd_longsword",
  "damage_type": {
   "name": "Slashing",
   "key": "slashing"
  },
  "damage_dice": "1d8",
  "properties": [
   {
    "property": {
     "name": "Versatile",
     "type": null,
     "desc": ""
    },
    "detail": "1d10"
   }
  ],
  "is_simple": false,
  "is_martial": true,
  "is_improvised": false,
  "distance_unit": "feet"
 },
 "armor": null,
 "weight": "3.000",
 "weight_unit": "lb",
 "cost": "15.00"
};

export const CHAIN_MAIL = {
 "key": "srd_chain-mail",
 "name": "Chain mail",
 "desc": "Made of interlocking metal rings, chain mail includes a layer of quilted fabric worn underneath the mail to prevent chafing and to cushion the impact of blows. The suit includes gauntlets.",
 "category": {
  "name": "Armor",
  "key": "armor"
 },
 "weapon": null,
 "armor": {
  "name": "Chain mail",
  "key": "srd_chain-mail",
  "category": "heavy",
  "ac_base": 16,
  "ac_display": "16",
  "ac_add_dexmod": false,
  "ac_cap_dexmod": null,
  "grants_stealth_disadvantage": true,
  "strength_score_required": 13
 },
 "weight": "55.000",
 "weight_unit": "lb",
 "cost": "75.00"
};

export const FIREBALL = {
 "key": "srd_fireball",
 "name": "Fireball",
 "desc": "A bright streak flashes from your pointing finger to a point",
 "level": 3,
 "school": {
  "name": "Evocation",
  "key": "evocation"
 },
 "classes": [
  {
   "name": "Sorcerer",
   "key": "srd_sorcerer"
  },
  {
   "name": "Wizard",
   "key": "srd_wizard"
  }
 ],
 "ritual": false,
 "casting_time": "action",
 "reaction_condition": null,
 "range_text": "150 feet",
 "verbal": true,
 "somatic": true,
 "material": true,
 "material_specified": "A tiny ball of bat guano and sulfur.",
 "duration": "instantaneous",
 "concentration": false,
 "higher_level": "When you cast this spell using a spell slot of 4th level or higher, the damage increases by 1d6 for each slot level above 3rd."
};
