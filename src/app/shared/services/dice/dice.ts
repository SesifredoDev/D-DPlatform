/**
 * Dice expressions in text: `2d10+7`, `d20`, `3d6 + 2d8 + 1`, `1d6 - 1`, any number of terms.
 * A term is dice (`NdM`, `dM` = 1dM) or a flat number; an expression needs at least one dice term
 * (so "+4 to hit" or "2024-10-12" are not dice). A bare `3d` has no die size and isn't a term.
 *
 * Pure functions, no Angular.
 */

/** Caps so a typo like `999999d999999` can't freeze the app. */
const MAX_DICE_PER_TERM = 1000;
const MAX_SIDES = 100000;

const TERM = String.raw`(?:\d*[dD]\d+|\d+)`;
const OPERATOR = String.raw`\s*[+\-−–]\s*`;
/** A whole expression, not glued to letters or digits on either side. */
const EXPRESSION = new RegExp(String.raw`(?<![\w.])${TERM}(?:${OPERATOR}${TERM})*(?![\w])`, 'g');
const HAS_DICE = /\d*[dD]\d+/;

export interface DiceMatch {
  /** The expression as written, e.g. "2d10 + 7". */
  text: string;
  /** Offset in the searched text. */
  index: number;
}

/** Every dice expression in a text, in order. */
export function findDiceExpressions(text: string): DiceMatch[] {
  const matches: DiceMatch[] = [];
  for (const match of text.matchAll(EXPRESSION)) {
    // Plain arithmetic ("5 - 6", "18,000") matches the pattern but has no dice.
    if (HAS_DICE.test(match[0]) && isDiceExpression(match[0])) {
      matches.push({ text: match[0], index: match.index ?? 0 });
    }
  }
  return matches;
}

export interface DiceTerm {
  sign: 1 | -1;
  /** Number of dice; 0 for a flat number. */
  count: number;
  /** Die size; 0 for a flat number. */
  sides: number;
  /** The flat value (for numbers). */
  value: number;
}

/** Terms of an expression, or null when it isn't a valid dice expression. */
export function parseDiceExpression(expression: string): DiceTerm[] | null {
  const compact = expression.replace(/\s+/g, '').replace(/[−–]/g, '-');
  if (!compact || !/^[+-]?(\d*[dD]\d+|\d+)([+-](\d*[dD]\d+|\d+))*$/.test(compact)) return null;

  const terms: DiceTerm[] = [];
  for (const match of compact.matchAll(/([+-]?)(\d*)([dD]?)(\d+)/g)) {
    const sign = match[1] === '-' ? -1 : 1;
    if (match[3]) {
      const count = match[2] === '' ? 1 : Number(match[2]);
      const sides = Number(match[4]);
      if (count < 1 || sides < 1 || count > MAX_DICE_PER_TERM || sides > MAX_SIDES) return null;
      terms.push({ sign, count, sides, value: 0 });
    } else {
      terms.push({ sign, count: 0, sides: 0, value: Number(match[4]) });
    }
  }
  return terms.some(term => term.count > 0) ? terms : null;
}

export function isDiceExpression(expression: string): boolean {
  return parseDiceExpression(expression) !== null;
}

export interface DiceRollPart {
  sign: 1 | -1;
  /** "2d10", or "7" for a flat number. */
  label: string;
  /** Each die's result (empty for a flat number). */
  rolls: number[];
  sides: number;
  /** Sum of this part, before its sign. */
  subtotal: number;
}

export interface DiceRoll {
  /** The expression as written. */
  expression: string;
  total: number;
  parts: DiceRollPart[];
  /** A single d20 that came up 20 / 1. */
  critical: 'success' | 'failure' | null;
}

/** Rolls an expression; null when it isn't one. `random` returns [0, 1) (Math.random by default). */
export function rollDice(expression: string, random: () => number = secureRandom): DiceRoll | null {
  const terms = parseDiceExpression(expression);
  if (!terms) return null;

  const parts: DiceRollPart[] = terms.map(term => {
    if (!term.count) return { sign: term.sign, label: String(term.value), rolls: [], sides: 0, subtotal: term.value };
    const rolls = Array.from({ length: term.count }, () => 1 + Math.floor(random() * term.sides));
    return {
      sign: term.sign,
      label: `${term.count}d${term.sides}`,
      rolls,
      sides: term.sides,
      subtotal: rolls.reduce((sum, roll) => sum + roll, 0),
    };
  });

  const total = parts.reduce((sum, part) => sum + part.sign * part.subtotal, 0);
  const d20s = parts.filter(part => part.sides === 20 && part.rolls.length === 1);
  const critical = d20s.length === 1 && parts.filter(part => part.rolls.length).length === 1
    ? d20s[0].rolls[0] === 20 ? 'success' : d20s[0].rolls[0] === 1 ? 'failure' : null
    : null;
  return { expression: expression.trim(), total, parts, critical };
}

/** "(3 + 9) + 7", for showing how a total was made. */
export function describeRoll(roll: DiceRoll): string {
  return roll.parts
    .map((part, i) => {
      const value = part.rolls.length > 1 ? `(${part.rolls.join(' + ')})` : part.rolls.length ? String(part.rolls[0]) : part.label;
      const sign = part.sign < 0 ? '− ' : i ? '+ ' : '';
      return `${sign}${value}`;
    })
    .join(' ');
}

/** The roll as a chat message: "🎲 Bite: **2d10 + 8** → **19** (3 + 8) + 8". */
export function rollMessage(roll: DiceRoll, label?: string): string {
  const crit = roll.critical === 'success' ? ' — natural 20!' : roll.critical === 'failure' ? ' — natural 1' : '';
  const prefix = label ? `${label}: ` : '';
  return `🎲 ${prefix}\`${roll.expression}\` → **${roll.total}** · ${describeRoll(roll)}${crit}`;
}

function secureRandom(): number {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0] / 2 ** 32;
  }
  return Math.random();
}
