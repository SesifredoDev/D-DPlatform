import { describeRoll, findDiceExpressions, isDiceExpression, parseDiceExpression, rollDice, rollMessage } from './dice';

/** Returns the given die faces in turn, for a die of `sides` sides. */
function faces(sides: number, ...values: number[]): () => number {
  let i = 0;
  return () => (values[i++ % values.length] - 1) / sides + 1e-9;
}

describe('findDiceExpressions', () => {
  it('finds expressions of any length, with or without spaces', () => {
    expect(findDiceExpressions('Hit: 15 (2d6 + 8) bludgeoning, then 3d6+2d8+1d4+1d12-2 more.').map(m => m.text))
      .toEqual(['2d6 + 8', '3d6+2d8+1d4+1d12-2']);
    expect(findDiceExpressions('Roll a d20, add 2d10+7.').map(m => m.text)).toEqual(['d20', '2d10+7']);
  });

  it('reports where each match is', () => {
    const text = 'Deals 1d6 − 1 damage';
    const [match] = findDiceExpressions(text);
    expect(match.text).toBe('1d6 − 1');
    expect(text.slice(match.index, match.index + match.text.length)).toBe('1d6 − 1');
  });

  it('ignores text that only looks like numbers or dice', () => {
    expect(findDiceExpressions('+4 to hit, Recharge 5-6, 18,000 XP, 2024-10-12, a 3d printer, 3d+2, d20s, Ad20')).toEqual([]);
  });
});

describe('parseDiceExpression', () => {
  it('reads dice and flat terms with signs', () => {
    expect(parseDiceExpression('2d10 + 7 - d4')).toEqual([
      { sign: 1, count: 2, sides: 10, value: 0 },
      { sign: 1, count: 0, sides: 0, value: 7 },
      { sign: -1, count: 1, sides: 4, value: 0 },
    ]);
  });

  it('rejects expressions without dice, bare "3d" and absurd sizes', () => {
    expect(isDiceExpression('7 + 2')).toBe(false);
    expect(isDiceExpression('3d')).toBe(false);
    expect(isDiceExpression('3d+2d8+1')).toBe(false);
    expect(isDiceExpression('5000d6')).toBe(false);
    expect(isDiceExpression('3d6+2d8+1')).toBe(true);
  });
});

describe('rollDice', () => {
  it('adds dice and modifiers', () => {
    const roll = rollDice('2d10+7', faces(10, 3, 9))!;
    expect(roll.total).toBe(19);
    expect(roll.parts.map(part => part.rolls)).toEqual([[3, 9], []]);
    expect(describeRoll(roll)).toBe('(3 + 9) + 7');
  });

  it('subtracts negative terms', () => {
    const roll = rollDice('1d6 - 1d4 - 2', faces(6, 5, 1))!;
    expect(roll.total).toBe(5 - 1 - 2);
    expect(describeRoll(roll)).toBe('5 − 1 − 2');
  });

  it('keeps every die within its range', () => {
    for (let i = 0; i < 200; i++) {
      const roll = rollDice('10d6+5d20')!;
      expect(roll.parts[0].rolls.every(value => value >= 1 && value <= 6)).toBe(true);
      expect(roll.parts[1].rolls.every(value => value >= 1 && value <= 20)).toBe(true);
    }
  });

  it('flags natural 20s and 1s on a single d20', () => {
    expect(rollDice('d20+5', () => 0.99)!.critical).toBe('success');
    expect(rollDice('1d20', () => 0)!.critical).toBe('failure');
    expect(rollDice('2d20', () => 0.99)!.critical).toBeNull();
    expect(rollDice('1d20+1d6', () => 0.99)!.critical).toBeNull();
  });

  it('formats a chat message', () => {
    const roll = rollDice('2d6 + 8', faces(6, 4, 2))!;
    expect(rollMessage(roll, 'Bite')).toBe('🎲 Bite: `2d6 + 8` → **14** · (4 + 2) + 8');
    expect(rollMessage(rollDice('d20', () => 0.99)!)).toBe('🎲 `d20` → **20** · 20 — natural 20!');
  });
});
