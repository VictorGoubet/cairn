import { describe, expect, it } from 'vitest';
import template from '../../src/config/hiking-mountain.brf?raw';

// The presets patch the BRouter profile template with regexes. If the template is ever
// resynced from upstream with different spacing, a silent no-match would route with the
// standard profile while the UI claims a preset is active. These tests pin the contract.
const PATCHES: [string, RegExp, string][] = [
  ['avoid_roads', /^assign {3}path_preference {10}0\.0/m, 'assign   path_preference          20.0'],
  ['easy_up', /^assign {3}consider_elevation {5}= false/m, 'assign   consider_elevation     = true'],
  ['shortest', /^assign {3}shortest_way {13}0/m, 'assign   shortest_way             1'],
];

describe('routing preset patches', () => {
  it('every pattern still matches the bundled profile', () => {
    for (const [name, pattern] of PATCHES) {
      expect(pattern.test(template), `${name} pattern`).toBe(true);
    }
  });

  it('each patch changes the profile exactly once', () => {
    for (const [name, pattern, replacement] of PATCHES) {
      const patched = template.replace(pattern, replacement);
      expect(patched, name).not.toBe(template);
      expect(patched.split('\n').length, name).toBe(template.split('\n').length);
      expect(pattern.test(patched), `${name} applied twice`).toBe(false);
    }
  });

  it('the profile declares the switches the presets rely on', () => {
    expect(template).toMatch(/^assign {3}path_preference/m);
    expect(template).toMatch(/^assign {3}consider_elevation/m);
    expect(template).toMatch(/^assign {3}shortest_way/m);
    // in shortest mode the cost is 1 + accesspenalty: distance decides, access still vetoes
    expect(template).toMatch(/if shortest_way {2}then \( {3}add 1 accesspenalty \)/);
  });
});
