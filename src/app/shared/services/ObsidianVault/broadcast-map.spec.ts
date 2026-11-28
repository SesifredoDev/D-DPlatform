import { broadcastMapBlock, broadcastMapsAsImages, hasBroadcastMap, playerPin, splitBroadcastContent } from './broadcast-map';
import { MapPin, VaultMap, parseVaultMap } from './vault-map';

const pin: MapPin = {
  id: 'p1', x: 0.25, y: 0.5, link: 'Lore/Waterdeep', label: '', icon: 'castle', color: '#e8a48f',
  size: 'large', layer: 'cities', gmOnly: false, note: 'kept out',
};

const map: VaultMap = {
  image: 'https://files.example/coast.jpg',
  size: null,
  pins: [playerPin(pin, 'Waterdeep', 'castle')],
  layers: [{ id: 'cities', name: 'Cities', visible: false }],
};

describe('broadcast maps', () => {
  it('gives players a named pin without its link or extra keys', () => {
    const player = playerPin({ ...pin, gmOnly: true }, 'Waterdeep', 'castle');
    expect(player).toEqual({ id: 'p1', x: 0.25, y: 0.5, link: null, label: 'Waterdeep', icon: 'castle', color: '#e8a48f', size: 'large', layer: 'cities', gmOnly: false });
  });

  it('round-trips a map through a message', () => {
    const message = `## Session 4\n\nWhere we are:\n\n${broadcastMapBlock('Sword Coast', map)}\n\nSee you there.`;
    expect(hasBroadcastMap(message)).toBe(true);
    const parts = splitBroadcastContent(message);
    expect(parts.map(part => part.kind)).toEqual(['markdown', 'map', 'markdown']);
    const part = parts[1];
    if (part.kind !== 'map') throw new Error('expected a map');
    expect(part.title).toBe('Sword Coast');
    expect(part.image).toBe('https://files.example/coast.jpg');
    const read = parseVaultMap(part.content);
    expect(read.pins[0].label).toBe('Waterdeep');
    expect(read.pins[0].link).toBeNull();
    expect(read.layers).toEqual([{ id: 'cities', name: 'Cities', visible: false }]);
  });

  it('leaves messages without maps (and broken blocks) as Markdown', () => {
    expect(splitBroadcastContent('Just text')).toEqual([{ kind: 'markdown', text: 'Just text' }]);
    const broken = '```astral-map\n{not json\n```';
    expect(splitBroadcastContent(broken)).toEqual([{ kind: 'markdown', text: broken }]);
  });

  it('writes maps as their image for notes', () => {
    const message = `Intro\n\n${broadcastMapBlock('Sword Coast', map)}`;
    expect(broadcastMapsAsImages(message)).toBe('Intro\n\n![Sword Coast](https://files.example/coast.jpg)');
    expect(broadcastMapsAsImages('No maps')).toBe('No maps');
  });
});
