/**
 * Family trees: their own file type (`*.familytree`), a small JSON file of people and relations.
 *
 *   {
 *     "type": "family-tree",
 *     "version": 1,
 *     "people": [{ "id": "…", "name": "Arya", "details": "b. 289 AC", "link": "NPCs/Arya Stark",
 *                  "portrait": "Images/arya.png" }],
 *     "relations": [{ "id": "…", "kind": "parent", "from": "<parent id>", "to": "<child id>" }]
 *   }
 *
 * `link` is a wikilink target (as in `[[NPCs/Arya Stark]]`). `portrait` is an image in the vault
 * (path or link text) or a web URL; without one, the first image in the linked note is shown. Relations are `parent` (from parent
 * to child) or `spouse` (no direction). The layout is computed, not stored. Keys the app doesn't
 * know are kept when the file is rewritten.
 *
 * Pure functions, no Angular. Edits return a new tree.
 */
import { isVaultFileType } from './vault-file-types';

export interface FamilyPerson {
  id: string;
  name: string;
  details: string;
  /** Link target of the person's note, as written in a wikilink; null when not linked. */
  link: string | null;
  /** The person's own picture: an image path / link target, or an http(s) URL; null when not set. */
  portrait: string | null;
  [key: string]: unknown;
}

export interface FamilyRelation {
  id: string;
  /** `parent`: `from` is a parent of `to`. `spouse`: no direction. */
  kind: 'parent' | 'spouse';
  from: string;
  to: string;
  [key: string]: unknown;
}

export interface FamilyTree {
  people: FamilyPerson[];
  relations: FamilyRelation[];
  [key: string]: unknown;
}

export interface PersonInput {
  name: string;
  details?: string;
  link?: string | null;
  portrait?: string | null;
}

export const PERSON_WIDTH = 200;
export const PERSON_HEIGHT = 72;
const SPOUSE_GAP = 40;
const UNIT_GAP = 60;
const GENERATION_GAP = 110;

/** True for `*.familytree` files. */
export function isFamilyTreePath(path: string): boolean {
  return isVaultFileType(path, 'family-tree');
}

export function emptyFamilyTree(): string {
  return serializeFamilyTree({ people: [], relations: [] });
}

/**
 * Reads a family tree file. Empty text is an empty tree. People without an id and relations that
 * point at missing people (or repeat another relation) are dropped. Anything that isn't a family
 * tree throws, so a broken file is never overwritten.
 */
export function parseFamilyTree(text: string): FamilyTree {
  if (!text.trim()) return { people: [], relations: [] };
  const data = JSON.parse(text) as Record<string, unknown> | null;
  if (!isObject(data)) throw new Error('Not a family tree file.');
  if (data['type'] !== undefined && data['type'] !== 'family-tree') throw new Error('Not a family tree file.');

  const people: FamilyPerson[] = [];
  const ids = new Set<string>();
  for (const raw of Array.isArray(data['people']) ? data['people'] : []) {
    if (!isObject(raw) || typeof raw['id'] !== 'string' || !raw['id'] || ids.has(raw['id'])) continue;
    ids.add(raw['id']);
    people.push({
      ...raw,
      id: raw['id'],
      name: typeof raw['name'] === 'string' ? raw['name'] : '',
      details: typeof raw['details'] === 'string' ? raw['details'] : '',
      link: typeof raw['link'] === 'string' && raw['link'].trim() ? raw['link'].trim() : null,
      portrait: typeof raw['portrait'] === 'string' && raw['portrait'].trim() ? raw['portrait'].trim() : null,
    });
  }

  const relations: FamilyRelation[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(data['relations']) ? data['relations'] : []) {
    if (!isObject(raw)) continue;
    const { from, to, kind } = raw;
    if (typeof from !== 'string' || typeof to !== 'string' || from === to || !ids.has(from) || !ids.has(to)) continue;
    if (kind !== 'parent' && kind !== 'spouse') continue;
    // One relation per pair of people.
    const pair = [from, to].sort().join('\u0000');
    if (seen.has(pair)) continue;
    seen.add(pair);
    relations.push({ ...raw, id: typeof raw['id'] === 'string' && raw['id'] ? raw['id'] : randomId(), kind, from, to });
  }

  const { people: _people, relations: _relations, ...rest } = data;
  return { ...rest, people, relations };
}

export function serializeFamilyTree(tree: FamilyTree): string {
  const { people, relations, type: _type, version: _version, ...rest } = tree;
  const clean = {
    type: 'family-tree',
    version: 1,
    ...rest,
    people: people.map(({ id, name, details, link, portrait, ...extra }) => ({
      id,
      name,
      ...(details ? { details } : {}),
      ...(link ? { link } : {}),
      ...(portrait ? { portrait } : {}),
      ...extra,
    })),
    relations,
  };
  return `${JSON.stringify(clean, null, 2)}\n`;
}

/** "NPCs/Arya Stark.md#Early life" → "Arya Stark". */
export function linkBaseName(link: string): string {
  const path = link.split('#')[0].trim();
  return (path.split('/').pop() || path).replace(/\.md$/i, '');
}

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|bmp|tiff|avif)$/i;

/**
 * Image references in a note, in the order they appear: `![[embeds]]`, `![alt](src)` images, and
 * `[[links]]` / bare paths to image files (e.g. an `image:` property). Code blocks are skipped.
 * Embeds of other notes are included too; the caller keeps the first one that is an image.
 */
export function noteImageCandidates(content: string): string[] {
  const text = content.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '');
  const pattern = /(!?)\[\[([^\]|#\n]+)(?:[|#][^\]\n]*)?\]\]|!\[[^\]\n]*\]\(\s*<?([^)>\s]+)>?[^)\n]*\)|(?:^|[\s:"'])((?:https?:\/\/)?[^\s"'[\]()]+\.(?:png|jpe?g|gif|webp|svg|bmp|tiff|avif))(?=$|[\s"'])/gim;
  const found: string[] = [];
  for (const match of text.matchAll(pattern)) {
    let candidate: string | null = null;
    if (match[2] !== undefined) {
      const target = match[2].trim();
      if (match[1] || IMAGE_EXTENSION.test(target)) candidate = target;
    } else if (match[3] !== undefined) {
      candidate = safeDecode(match[3]);
    } else if (match[4] !== undefined) {
      candidate = safeDecode(match[4]);
    }
    if (candidate && !found.includes(candidate)) found.push(candidate);
  }
  return found;
}

function safeDecode(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

// ---- Edits ----

export function addPerson(tree: FamilyTree, input: PersonInput): { tree: FamilyTree; id: string } {
  const id = newId(tree);
  const person: FamilyPerson = {
    id,
    name: input.name.trim() || 'Unnamed',
    details: (input.details ?? '').trim(),
    link: input.link?.trim() || null,
    portrait: input.portrait?.trim() || null,
  };
  return { tree: { ...tree, people: [...tree.people, person] }, id };
}

export function updatePerson(tree: FamilyTree, id: string, patch: Partial<PersonInput>): FamilyTree {
  return {
    ...tree,
    people: tree.people.map(person => {
      if (person.id !== id) return person;
      return {
        ...person,
        name: patch.name !== undefined ? patch.name.trim() || person.name : person.name,
        details: patch.details !== undefined ? patch.details.trim() : person.details,
        link: patch.link !== undefined ? patch.link?.trim() || null : person.link,
        portrait: patch.portrait !== undefined ? patch.portrait?.trim() || null : person.portrait,
      };
    }),
  };
}

export function removePerson(tree: FamilyTree, id: string): FamilyTree {
  return {
    ...tree,
    people: tree.people.filter(person => person.id !== id),
    relations: tree.relations.filter(relation => relation.from !== id && relation.to !== id),
  };
}

/**
 * Adds a relation. For `parent`, `a` is the parent and `b` the child. Returns an error (and the
 * tree unchanged) when the relation makes no sense.
 */
export function addRelation(tree: FamilyTree, kind: FamilyRelation['kind'], a: string, b: string): { tree: FamilyTree; error: string | null } {
  if (a === b) return { tree, error: 'A person can’t be related to themselves.' };
  const nameOf = (id: string) => tree.people.find(person => person.id === id)?.name || 'Unnamed';
  if (!tree.people.some(person => person.id === a) || !tree.people.some(person => person.id === b)) {
    return { tree, error: 'That person isn’t in this tree.' };
  }

  const existing = tree.relations.find(relation =>
    (relation.from === a && relation.to === b) || (relation.from === b && relation.to === a));
  if (existing) {
    if (existing.kind === kind && (kind === 'spouse' || existing.from === a)) return { tree, error: null };
    return { tree, error: `${nameOf(a)} and ${nameOf(b)} are already related.` };
  }
  if (kind === 'parent' && isAncestor(tree, b, a)) {
    return { tree, error: `${nameOf(b)} is already an ancestor of ${nameOf(a)}.` };
  }

  const relation: FamilyRelation = { id: newId(tree), kind, from: a, to: b };
  return { tree: { ...tree, relations: [...tree.relations, relation] }, error: null };
}

export function removeRelation(tree: FamilyTree, relationId: string): FamilyTree {
  return { ...tree, relations: tree.relations.filter(relation => relation.id !== relationId) };
}

/** True if `ancestor` is a parent, grandparent… of `person`. */
export function isAncestor(tree: FamilyTree, ancestor: string, person: string): boolean {
  const parentsOf = groupParents(tree);
  const seen = new Set<string>();
  const stack = [...(parentsOf.get(person) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === ancestor) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(parentsOf.get(id) ?? []));
  }
  return false;
}

export interface PersonRelatives {
  parents: { person: FamilyPerson; relation: FamilyRelation }[];
  spouses: { person: FamilyPerson; relation: FamilyRelation }[];
  children: { person: FamilyPerson; relation: FamilyRelation }[];
}

export function relativesOf(tree: FamilyTree, id: string): PersonRelatives {
  const byId = new Map(tree.people.map(person => [person.id, person]));
  const result: PersonRelatives = { parents: [], spouses: [], children: [] };
  for (const relation of tree.relations) {
    if (relation.kind === 'spouse') {
      const other = relation.from === id ? relation.to : relation.to === id ? relation.from : null;
      if (other && byId.has(other)) result.spouses.push({ person: byId.get(other)!, relation });
    } else if (relation.to === id && byId.has(relation.from)) {
      result.parents.push({ person: byId.get(relation.from)!, relation });
    } else if (relation.from === id && byId.has(relation.to)) {
      result.children.push({ person: byId.get(relation.to)!, relation });
    }
  }
  return result;
}

// ---- Layout ----

export interface PersonPosition {
  x: number;
  y: number;
  generation: number;
}

/**
 * Generations top to bottom (children below their lowest parent, spouses side by side), each row
 * ordered so families stay together, then parents centred over their children.
 */
export function layoutFamilyTree(tree: FamilyTree): Map<string, PersonPosition> {
  const ids = tree.people.map(person => person.id);
  const order = new Map(ids.map((id, i) => [id, i]));
  const parentsOf = groupParents(tree);
  const childrenOf = new Map<string, string[]>();
  const spousesOf = new Map<string, string[]>();
  for (const relation of tree.relations) {
    if (relation.kind === 'parent') push(childrenOf, relation.from, relation.to);
    else {
      push(spousesOf, relation.from, relation.to);
      push(spousesOf, relation.to, relation.from);
    }
  }

  // Generations. Bounded, so a cycle written by hand can't loop forever.
  const generation = new Map(ids.map(id => [id, 0]));
  for (let pass = 0; pass <= ids.length + 1; pass++) {
    let changed = false;
    for (const relation of tree.relations) {
      const a = generation.get(relation.from)!;
      const b = generation.get(relation.to)!;
      if (relation.kind === 'parent' && b < a + 1) {
        generation.set(relation.to, a + 1);
        changed = true;
      } else if (relation.kind === 'spouse' && a !== b) {
        generation.set(a < b ? relation.from : relation.to, Math.max(a, b));
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Units: people married to each other in the same generation, kept side by side.
  const generations: string[][][] = [];
  const unitOf = new Map<string, string[]>();
  for (const id of ids) {
    if (unitOf.has(id)) continue;
    const gen = generation.get(id)!;
    const unit = spouseChain(id, spousesOf, other => generation.get(other) === gen && !unitOf.has(other));
    unit.forEach(member => unitOf.set(member, unit));
    (generations[gen] ??= []).push(unit);
  }

  const x = new Map<string, number>();
  const unitWidth = (unit: string[]) => unit.length * PERSON_WIDTH + (unit.length - 1) * SPOUSE_GAP;
  const centreOf = (members: string[]) => {
    const xs = members.filter(id => x.has(id)).map(id => x.get(id)! + PERSON_WIDTH / 2);
    return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
  };
  /** Places a row left to right, each unit as close to its wanted centre as the row allows. */
  const placeRow = (units: string[][], wanted: (unit: string[]) => number | null) => {
    let cursor = -Infinity;
    for (const unit of units) {
      const centre = wanted(unit);
      const width = unitWidth(unit);
      let start = centre === null ? (cursor === -Infinity ? 0 : cursor) : centre - width / 2;
      if (start < cursor) start = cursor;
      unit.forEach((id, i) => x.set(id, start + i * (PERSON_WIDTH + SPOUSE_GAP)));
      cursor = start + width + UNIT_GAP;
    }
  };
  const parentsCentre = (unit: string[]) => centreOf(unit.flatMap(id => parentsOf.get(id) ?? []));
  const childrenCentre = (unit: string[]) => centreOf(unit.flatMap(id => childrenOf.get(id) ?? []));

  // Top down: order each row by where the parents are, then centre under them.
  generations.forEach((units, gen) => {
    if (!units) return;
    if (gen > 0) {
      const key = (unit: string[]) => parentsCentre(unit) ?? Infinity;
      units.sort((a, b) => key(a) - key(b) || order.get(a[0])! - order.get(b[0])!);
    }
    placeRow(units, gen > 0 ? parentsCentre : () => null);
  });
  // Bottom up: centre parents over their children, keeping the order.
  for (let gen = generations.length - 2; gen >= 0; gen--) {
    const units = generations[gen];
    if (!units) continue;
    const current = new Map(units.map(unit => [unit, centreOf(unit)]));
    placeRow(units, unit => childrenCentre(unit) ?? current.get(unit) ?? null);
  }

  const minX = Math.min(0, ...Array.from(x.values()));
  const positions = new Map<string, PersonPosition>();
  for (const id of ids) {
    const gen = generation.get(id)!;
    positions.set(id, { x: Math.round(x.get(id)! - minX), y: gen * (PERSON_HEIGHT + GENERATION_GAP), generation: gen });
  }
  return positions;
}

// ---- Helpers ----

function groupParents(tree: FamilyTree): Map<string, string[]> {
  const parentsOf = new Map<string, string[]>();
  for (const relation of tree.relations) {
    if (relation.kind === 'parent') push(parentsOf, relation.to, relation.from);
  }
  return parentsOf;
}

/** The spouse group around `start`, with the most-married person in the middle. */
function spouseChain(start: string, spousesOf: Map<string, string[]>, allowed: (id: string) => boolean): string[] {
  const members = [start];
  const seen = new Set(members);
  for (let i = 0; i < members.length; i++) {
    for (const other of spousesOf.get(members[i]) ?? []) {
      if (!seen.has(other) && allowed(other)) {
        seen.add(other);
        members.push(other);
      }
    }
  }
  if (members.length <= 2) return members;

  const centre = members.reduce((best, id) => (spousesOf.get(id)?.length ?? 0) > (spousesOf.get(best)?.length ?? 0) ? id : best, members[0]);
  const row = [centre];
  members.filter(id => id !== centre).forEach((id, i) => (i % 2 === 0 ? row.unshift(id) : row.push(id)));
  return row;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function randomId(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function newId(tree: FamilyTree): string {
  const taken = new Set([...tree.people.map(person => person.id), ...tree.relations.map(relation => relation.id)]);
  let id: string;
  do {
    id = randomId();
  } while (taken.has(id));
  return id;
}
