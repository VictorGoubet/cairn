import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { safeFileName, zipFiles } from '../../src/lib/zip';

describe('zipFiles', () => {
  it('writes an archive a real unzip can read', async () => {
    const blob = zipFiles([
      { name: 'J1 · Refuge.gpx', text: '<gpx><trk><name>J1</name></trk></gpx>' },
      { name: 'J2.gpx', text: '<gpx><trk><name>J2</name></trk></gpx>' },
    ]);
    expect(blob.type).toBe('application/zip');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // the signature of a local file header, which is how the format starts
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(bytes.length).toBeGreaterThan(120);
    // handed to the harness, which checks it with the system unzip
    writeFileSync('/tmp/cairn-zip-test.zip', bytes);
  });

  it('is byte for byte reproducible, having no clock in it', async () => {
    const once = await zipFiles([{ name: 'a.gpx', text: 'x' }]).arrayBuffer();
    const twice = await zipFiles([{ name: 'a.gpx', text: 'x' }]).arrayBuffer();
    expect(new Uint8Array(once)).toEqual(new Uint8Array(twice));
  });

  it('keeps a file name usable, and inside the archive', () => {
    expect(safeFileName('J1 · Col de l/Izoard')).toBe('J1 · Col de l-Izoard');
    expect(safeFileName('../../etc/passwd')).toBe('..-..-etc-passwd');
    expect(safeFileName('   ')).toBe('file');
  });
});
