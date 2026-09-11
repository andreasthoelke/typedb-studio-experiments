import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const maxPngBytes = 64 * 1024 * 1024;

export function validExportName(name) {
    return typeof name === 'string' && /^[\p{L}\p{N}_-]+$/u.test(name) && Buffer.byteLength(name) <= 160;
}

/** Exclusive creation checks the real directory and handles simultaneous exports. */
export async function saveGraphPng(directory, baseName, bytes) {
    if (!validExportName(baseName) || bytes.length < 24 || bytes.length > maxPngBytes
        || !bytes.subarray(0, 8).equals(pngSignature) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
        throw new Error('Invalid graph PNG or filename.');
    }
    await mkdir(directory, { recursive: true });
    for (let index = 0; index < 1000000; index++) {
        const filename = `${baseName}-${String(index).padStart(2, '0')}.png`;
        const path = join(directory, filename);
        let file;
        try { file = await open(path, 'wx'); }
        catch (error) { if (error.code === 'EEXIST') continue; throw error; }
        try { await file.writeFile(bytes); }
        catch (error) { await file.close(); await unlink(path).catch(() => {}); throw error; }
        await file.close();
        return { filename, path };
    }
    throw new Error('No available filename for this graph.');
}
