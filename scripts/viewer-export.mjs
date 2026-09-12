import { mkdir, open, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const maxPngBytes = 64 * 1024 * 1024;

export function validExportName(name) {
    return typeof name === 'string' && /^[\p{L}\p{N}_-]+$/u.test(name) && Buffer.byteLength(name) <= 160;
}

export function validProjectTempDirectory(directory) {
    return typeof directory === 'string' && directory.length <= 4096 && isAbsolute(directory) && !directory.includes('\0');
}

export function graphSnapshotDirectory(downloadsDirectory, projectTempDirectory, database) {
    if (projectTempDirectory == null) return downloadsDirectory;
    if (!validProjectTempDirectory(projectTempDirectory)) throw new Error('Expected an absolute project temp directory.');
    if (typeof database !== 'string' || !database.trim() || ['.', '..'].includes(database)
        || /[/\\\x00-\x1f]/.test(database) || Buffer.byteLength(database) > 200) {
        throw new Error('Expected a database name without path separators.');
    }
    return resolve(projectTempDirectory, 'snaps', database);
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
