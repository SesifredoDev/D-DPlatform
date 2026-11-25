/**
 * The vault's link graph, built from the index: notes as nodes, links between them as edges.
 * Pure functions, no Angular; drawing and layout live in the graph view component.
 */
import type { VaultEntry } from './obsidian-vault-service';
import type { GraphColorGroup, VaultIndex } from './vault-index.service';
import { getVaultDisplayName, isVaultFileType } from './vault-file-types';

export interface GraphNode {
  /** The file's path, or `missing:<name>` for a link to a note that doesn't exist yet. */
  id: string;
  /** The file's path; null for missing notes. */
  path: string | null;
  label: string;
  /** `note` = markdown, `file` = anything else that's linked (images, canvases, PDFs…). */
  kind: 'note' | 'file' | 'missing';
  /** Links in and out, after filtering. */
  degree: number;
  /** Colour from the first matching colour group, or null. */
  color: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface VaultGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphFilters {
  /** Keeps notes whose name or path contains this text (global graph only). */
  search: string;
  /** Keeps notes with this tag, nested tags included (global graph only). */
  tag: string | null;
  showAttachments: boolean;
  showOrphans: boolean;
  showMissing: boolean;
}

export const DEFAULT_GRAPH_FILTERS: GraphFilters = {
  search: '',
  tag: null,
  showAttachments: false,
  showOrphans: true,
  showMissing: false,
};

/** Distinct, readable on dark backgrounds. */
export const GRAPH_PALETTE = ['#e5734f', '#4fb3e5', '#8bd16a', '#d98ce0', '#e5c14f', '#5fd4c2', '#f08ca8', '#a3a3ff'];

/** Colour groups to use when the vault has no Obsidian graph settings: its most used tags. */
export function defaultColorGroups(index: VaultIndex, count = 6): GraphColorGroup[] {
  return index.getAllTags().slice(0, count).map((item, i) => ({ query: `tag:#${item.tag}`, color: GRAPH_PALETTE[i % GRAPH_PALETTE.length] }));
}

/**
 * Builds the graph. With `focus`, only notes within `depth` links of that note are kept (links in
 * either direction), and the search/tag filters don't apply.
 */
export function buildVaultGraph(
  index: VaultIndex,
  filters: GraphFilters,
  groups: GraphColorGroup[],
  focus: { path: string; depth: number } | null = null,
): VaultGraph {
  const nodes = new Map<string, GraphNode>();
  const edgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];

  const fileNode = (entry: VaultEntry): GraphNode => {
    const existing = nodes.get(entry.relativePath);
    if (existing) return existing;
    const node: GraphNode = {
      id: entry.relativePath,
      path: entry.relativePath,
      label: getVaultDisplayName(entry.name),
      kind: isVaultFileType(entry.name, 'markdown') ? 'note' : 'file',
      degree: 0,
      color: null,
    };
    nodes.set(node.id, node);
    return node;
  };

  // Every note is a node; other files only when something links to them.
  const notes = index.files.filter(entry => isVaultFileType(entry.name, 'markdown'));
  notes.forEach(fileNode);

  for (const note of notes) {
    for (const raw of index.getLinkTargets(note.relativePath)) {
      const target = index.resolveLink(raw, note.relativePath);
      let targetNode: GraphNode;
      if (target?.kind === 'file') {
        targetNode = fileNode(target);
      } else if (target) {
        continue; // a folder
      } else {
        const name = raw.split('#')[0].split('|')[0].trim();
        if (!name) continue;
        const id = `missing:${name.toLowerCase()}`;
        targetNode = nodes.get(id) ?? { id, path: null, label: name.split('/').pop() || name, kind: 'missing', degree: 0, color: null };
        nodes.set(id, targetNode);
      }
      if (targetNode.id === note.relativePath) continue;
      const key = [note.relativePath, targetNode.id].sort().join('\u0000');
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({ source: note.relativePath, target: targetNode.id });
    }
  }

  // Kind filters.
  let keep = new Set(
    Array.from(nodes.values())
      .filter(node => (node.kind !== 'file' || filters.showAttachments) && (node.kind !== 'missing' || filters.showMissing))
      .map(node => node.id),
  );
  if (focus) keep.add(focus.path);

  if (focus) {
    keep = neighbourhood(focus.path, focus.depth, edges, keep);
  } else {
    if (filters.tag) {
      const tagged = new Set(index.getNotesWithTag(filters.tag).map(entry => entry.relativePath));
      keep = new Set(Array.from(keep).filter(id => tagged.has(id)));
    }
    const query = filters.search.trim().toLowerCase();
    if (query) {
      keep = new Set(Array.from(keep).filter(id => {
        const node = nodes.get(id)!;
        return node.label.toLowerCase().includes(query) || (node.path ?? '').toLowerCase().includes(query);
      }));
    }
  }

  const keptEdges = edges.filter(edge => keep.has(edge.source) && keep.has(edge.target));
  for (const edge of keptEdges) {
    nodes.get(edge.source)!.degree++;
    nodes.get(edge.target)!.degree++;
  }

  const matchers = groups.map(group => ({ color: group.color, matches: compileQuery(group.query, index) }));
  const keptNodes = Array.from(keep)
    .map(id => nodes.get(id))
    .filter((node): node is GraphNode => !!node)
    .filter(node => filters.showOrphans || node.degree > 0 || node.id === focus?.path)
    .map(node => ({ ...node, color: matchers.find(matcher => matcher.matches(node))?.color ?? null }));

  const keptIds = new Set(keptNodes.map(node => node.id));
  return { nodes: keptNodes, edges: keptEdges.filter(edge => keptIds.has(edge.source) && keptIds.has(edge.target)) };
}

/** Nodes within `depth` steps of `start`, following edges both ways, among `allowed`. */
function neighbourhood(start: string, depth: number, edges: GraphEdge[], allowed: Set<string>): Set<string> {
  const adjacent = new Map<string, string[]>();
  for (const edge of edges) {
    if (!allowed.has(edge.source) || !allowed.has(edge.target)) continue;
    (adjacent.get(edge.source) ?? adjacent.set(edge.source, []).get(edge.source)!).push(edge.target);
    (adjacent.get(edge.target) ?? adjacent.set(edge.target, []).get(edge.target)!).push(edge.source);
  }
  const seen = new Set([start]);
  let frontier = [start];
  for (let step = 0; step < depth; step++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of adjacent.get(id) ?? []) {
        if (!seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/**
 * A matcher for a colour-group query in Obsidian search syntax. Supports `tag:#x`, `path:x`,
 * `file:x` and plain words (name or path), combined with spaces (and) and ` OR `. Anything else
 * never matches.
 */
export function compileQuery(query: string, index: VaultIndex): (node: GraphNode) => boolean {
  const alternatives = query.split(/\s+OR\s+/).map(part => part.trim()).filter(Boolean);
  const compiled = alternatives.map(part => {
    const terms = part.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
    return terms.map(term => compileTerm(term.replace(/"/g, ''), index));
  });
  return node => compiled.some(terms => terms.length > 0 && terms.every(term => term(node)));
}

function compileTerm(term: string, index: VaultIndex): (node: GraphNode) => boolean {
  const negate = term.startsWith('-');
  const body = negate ? term.slice(1) : term;
  const match = body.match(/^(\w+):(.*)$/);
  let test: (node: GraphNode) => boolean;

  if (match) {
    const value = match[2].toLowerCase();
    switch (match[1].toLowerCase()) {
      case 'tag': {
        const tag = value.replace(/^#/, '');
        test = node => !!node.path && index.getTags(node.path).some(t => t === tag || t.startsWith(`${tag}/`));
        break;
      }
      case 'path':
        test = node => (node.path ?? '').toLowerCase().includes(value);
        break;
      case 'file':
        test = node => node.label.toLowerCase().includes(value);
        break;
      default:
        test = () => false;
    }
  } else {
    const value = body.toLowerCase();
    test = node => node.label.toLowerCase().includes(value) || (node.path ?? '').toLowerCase().includes(value);
  }
  return negate ? node => !test(node) : test;
}

/** A cheap fingerprint of the graph's shape, to skip relayout when only content changed. */
export function graphSignature(graph: VaultGraph): string {
  return `${graph.nodes.map(node => `${node.id}|${node.color ?? ''}`).join('\n')}\u0001${graph.edges.map(edge => `${edge.source}>${edge.target}`).join('\n')}`;
}
