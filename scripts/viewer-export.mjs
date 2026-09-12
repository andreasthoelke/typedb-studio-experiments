import { mkdir, open, unlink, stat, lstat, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const maxPngBytes = 64 * 1024 * 1024;

export function validExportName(name) {
    return typeof name === 'string' && /^[\p{L}\p{N}_-]+$/u.test(name) && Buffer.byteLength(name) <= 160;
}

export function validProjectTempDirectory(directory) {
    return typeof directory === 'string' && directory.length <= 4096 && isAbsolute(directory) && !directory.includes('\0');
}

export function graphSnapshotDirectory(projectTempDirectory, database, folder = 'snaps') {
    if (projectTempDirectory == null) throw new Error('Choose a project in Snaps, or run a query from its temp/schema file in Neovim.');
    if (!validProjectTempDirectory(projectTempDirectory)) throw new Error('Expected an absolute project temp directory.');
    if (typeof database !== 'string' || !database.trim() || ['.', '..'].includes(database)
        || /[/\\\x00-\x1f]/.test(database) || Buffer.byteLength(database) > 200) {
        throw new Error('Expected a database name without path separators.');
    }
    if (!['snaps', 'imgs'].includes(folder)) throw new Error('Invalid graph folder.');
    return resolve(projectTempDirectory, folder, database);
}

/** Accept a project root, its temp directory, or a file inside that temp directory. */
export async function selectSnapshotProject(path, database) {
    if (typeof path !== 'string' || !path.trim()) throw new Error('Enter a project folder or temp/schema file path.');
    path = path.trim().replace(/^~(?=\/|$)/, homedir());
    if (!validProjectTempDirectory(path)) throw new Error('Use an absolute path or ~/… for the project.');
    path = resolve(path);
    const info = await stat(path).catch(() => null);
    if (!info || (!info.isDirectory() && !info.isFile())) throw new Error('That project folder or schema file does not exist.');
    if (info.isFile()) {
        path = dirname(path);
        if (basename(path) !== 'temp') throw new Error('Select the project folder or a file directly inside its temp folder.');
    }
    const projectTempDirectory = basename(path) === 'temp' ? path : join(path, 'temp');
    const directory = graphSnapshotDirectory(projectTempDirectory, database);
    const imageDirectory = graphSnapshotDirectory(projectTempDirectory, database, 'imgs');
    await mkdir(directory, { recursive: true });
    await mkdir(imageDirectory, { recursive: true });
    return { database, projectTempDirectory, directory, imageDirectory };
}

function validSnapFilename(filename) {
    return typeof filename === 'string' && /^[\p{L}\p{N}_-]+\.snap\.json$/u.test(filename)
        && Buffer.byteLength(filename) <= 255;
}

// Cache only compact metadata; graph documents are released after inspection.
const snapMetadata = new Map();
export async function listGraphSnaps(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    const files = [];
    for (const entry of entries.filter(e => e.isFile() && validSnapFilename(e.name))) {
        const path = join(directory, entry.name);
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) continue;
        const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
        let cached = snapMetadata.get(path);
        if (!cached || cached.stamp !== stamp) {
            let metadata = { kind: 'unknown' };
            try {
                const snap = await readGraphSnap(directory, entry.name);
                if (snap.format === 'typedb-studio-graph-snap' && Array.isArray(snap.graph?.nodes)) {
                    const names = [...new Set(snap.graph.nodes.map(node => {
                        const concept = node.attributes?.metadata?.concept;
                        return concept?.type?.label ?? concept?.label;
                    }).filter(name => typeof name === 'string'))];
                    const words = names.flatMap(name => name.split(/[-_\s]+/)).filter(Boolean);
                    const abbreviation = words.slice(0, 10).map(word => [...word].slice(0, 2).join('')).join(' ')
                        + (words.length > 10 ? ' ..' : '');
                    metadata = { kind: snap.schemaMode ? 'schema' : 'data', nodeCount: snap.graph.nodes.length, abbreviation };
                }
            } catch { /* Keep unreadable files visible; opening reports the error. */ }
            cached = { stamp, metadata };
            if (snapMetadata.size >= 500) snapMetadata.delete(snapMetadata.keys().next().value);
            snapMetadata.set(path, cached);
        }
        files.push({ filename: entry.name, modifiedAt: info.mtime.toISOString(), bytes: info.size, ...cached.metadata });
    }
    return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.filename.localeCompare(b.filename));
}

export async function readGraphSnap(directory, filename) {
    if (!validSnapFilename(filename)) throw new Error('Invalid snap filename.');
    const file = await open(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await file.stat();
        if (!info.isFile() || info.size > maxPngBytes) throw new Error('Invalid snap file or size (maximum 64 MiB).');
        return JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
}

export async function deleteGraphSnap(directory, filename) {
    if (!validSnapFilename(filename)) throw new Error('Invalid snap filename.');
    const path = join(directory, filename);
    if (!(await lstat(path)).isFile()) throw new Error('Expected a regular snap file.');
    await unlink(path);
    snapMetadata.delete(path);
    return { filename };
}

/** Exclusive creation checks the real directory and handles simultaneous exports. */
export async function saveGraphPng(directory, baseName, bytes) {
    if (!validExportName(baseName) || bytes.length < 24 || bytes.length > maxPngBytes
        || !bytes.subarray(0, 8).equals(pngSignature) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
        throw new Error('Invalid graph PNG or filename.');
    }
    return saveNumberedFile(directory, baseName, bytes, '.png');
}

export async function saveGraphSnap(directory, baseName, bytes) {
    if (!validExportName(baseName) || bytes.length > maxPngBytes) throw new Error('Invalid snap filename or size.');
    const snap = JSON.parse(bytes.toString('utf8'));
    if (snap?.format !== 'typedb-studio-graph-snap' || snap.version !== 1 || !Array.isArray(snap.graph?.nodes)
        || !Array.isArray(snap.graph?.edges) || !snap.view || typeof snap.query !== 'string') throw new Error('Invalid graph snap.');
    return saveNumberedFile(directory, baseName, bytes, '.snap.json');
}

async function saveNumberedFile(directory, baseName, bytes, extension) {
    await mkdir(directory, { recursive: true });
    for (let index = 0; index < 1000000; index++) {
        const filename = `${baseName}-${String(index).padStart(2, '0')}${extension}`;
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
