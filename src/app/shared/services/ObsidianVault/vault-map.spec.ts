import {
  addLayer,
  addPin,
  emptyVaultMap,
  findPinByAnchor,
  isMapLink,
  isVaultMapPath,
  mapLinks,
  parseVaultMap,
  removeLayer,
  removePin,
  rewriteMapLinks,
  serializeVaultMap,
  updateLayer,
  updatePin,
  visiblePins,
} from './vault-map';

const FILE = JSON.stringify({
  type: 'map',
  version: 1,
  image: 'Maps/coast.jpg',
  size: { width: 4000, height: 3000 },
  pins: [
    { id: 'p1', x: 0.4, y: 0.3, link: 'Locations/Waterdeep', label: '', icon: 'castle', color: '#fff', size: 'large', layer: 'cities' },
    { id: 'p2', x: 0.7, y: 0.6, link: 'Maps/Undermountain.map', label: 'Undermountain', gmOnly: true, custom: 'kept' },
    { id: 'p3', x: 2, y: -1, link: null, label: 'Shipwreck' },
  ],
  layers: [{ id: 'cities', name: 'Cities', visible: false }],
  theme: 'parchment',
});

describe('parseVaultMap', () => {
  it('reads pins, clamps positions and keeps unknown keys', () => {
    const map = parseVaultMap(FILE);
    expect(map.image).toBe('Maps/coast.jpg');
    expect(map.size).toEqual({ width: 4000, height: 3000 });
    expect(map.pins.map(pin => pin.id)).toEqual(['p1', 'p2', 'p3']);
    expect(map.pins[2]).toMatchObject({ x: 1, y: 0, icon: 'location_on', size: 'normal', gmOnly: false });
    expect(map.pins[1]['custom']).toBe('kept');
    expect(map['theme']).toBe('parchment');
    expect(parseVaultMap(serializeVaultMap(map))).toEqual(map);
  });

  it('starts empty and rejects other files', () => {
    expect(parseVaultMap(emptyVaultMap())).toEqual({ image: null, size: null, pins: [], layers: [] });
    expect(() => parseVaultMap('{ nope')).toThrow(/valid JSON/);
    expect(() => parseVaultMap('{"type":"family-tree"}')).toThrow(/isn’t a map/);
    expect(() => parseVaultMap('[1,2]')).toThrow();
  });
});

describe('editing', () => {
  it('adds, moves and removes pins', () => {
    let map = parseVaultMap(emptyVaultMap());
    const added = addPin(map, { x: 0.25, y: 0.5, link: 'Phandalin' });
    map = added.map;
    expect(added.pin).toMatchObject({ x: 0.25, y: 0.5, link: 'Phandalin', icon: 'location_on', label: '' });
    expect(addPin(map, { x: 0, y: 0, link: 'Sub.map' }).pin.icon).toBe('layers');

    map = updatePin(map, added.pin.id, { x: 1.5, label: 'Town' });
    expect(map.pins[0]).toMatchObject({ x: 1, label: 'Town', id: added.pin.id });
    expect(removePin(map, added.pin.id).pins).toEqual([]);
  });

  it('hides pins on hidden layers and GM-only pins when asked', () => {
    const map = parseVaultMap(FILE);
    expect(visiblePins(map).map(pin => pin.id)).toEqual(['p2', 'p3']);
    expect(visiblePins(map, { includeGmOnly: false }).map(pin => pin.id)).toEqual(['p3']);
    const shown = updateLayer(map, 'cities', { visible: true });
    expect(visiblePins(shown).map(pin => pin.id)).toEqual(['p1', 'p2', 'p3']);
    const removed = removeLayer(map, 'cities');
    expect(removed.layers).toEqual([]);
    expect(removed.pins[0].layer).toBeNull();
    expect(addLayer(map, '  ').layer.name).toBe('Layer');
  });
});

describe('links', () => {
  it('finds a pin from a link anchor', () => {
    const map = parseVaultMap(FILE);
    expect(findPinByAnchor(map, 'waterdeep')?.id).toBe('p1');
    expect(findPinByAnchor(map, 'Undermountain')?.id).toBe('p2');
    expect(findPinByAnchor(map, 'p3')?.id).toBe('p3');
    expect(findPinByAnchor(map, 'Neverwinter')).toBeNull();
  });

  it('lists pins and the vault image as links', () => {
    expect(mapLinks(parseVaultMap(FILE))).toEqual([
      { target: 'Locations/Waterdeep', snippet: '📍 Waterdeep', kind: 'pin' },
      { target: 'Maps/Undermountain.map', snippet: '📍 Undermountain', kind: 'pin' },
      { target: 'Maps/coast.jpg', snippet: 'Map image', kind: 'image' },
    ]);
    expect(mapLinks({ image: 'https://x.test/a.png', size: null, pins: [], layers: [] })).toEqual([]);
  });

  it('rewrites moved notes and images, keeping anchors', () => {
    const text = FILE.replace('"Locations/Waterdeep"', '"Locations/Waterdeep#Docks"');
    const result = rewriteMapLinks(text, {
      mapPath: 'Maps/Coast.map',
      resolve: target => ({ 'Locations/Waterdeep': 'Locations/Waterdeep.md', 'Maps/coast.jpg': 'Maps/coast.jpg' } as Record<string, string>)[target] ?? null,
      moved: new Map([['locations/waterdeep.md', 'Cities/Waterdeep.md'], ['maps/coast.jpg', 'Art/coast.jpg']]),
      linkTextFor: path => path.replace(/\.md$/, ''),
    });
    expect(result.count).toBe(2);
    const map = parseVaultMap(result.content);
    expect(map.pins[0].link).toBe('Cities/Waterdeep#Docks');
    expect(map.image).toBe('Art/coast.jpg');
    expect(map.pins[1].link).toBe('Maps/Undermountain.map');
  });

  it('recognises map files and map links', () => {
    expect(isVaultMapPath('Maps/Coast.map')).toBe(true);
    expect(isVaultMapPath('Maps/Coast.md')).toBe(false);
    expect(isMapLink('Sub.map#Gate')).toBe(true);
    expect(isMapLink('Waterdeep')).toBe(false);
  });
});

describe('nested maps', () => {
  it('finds the pin leading to a sub-map by the sub-map’s name', () => {
    const map = parseVaultMap(JSON.stringify({ pins: [{ id: 'gate', x: 0.5, y: 0.5, link: 'Maps/Undermountain.map' }] }));
    expect(findPinByAnchor(map, 'Undermountain')?.id).toBe('gate');
  });
});
