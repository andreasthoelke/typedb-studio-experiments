import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { maxPngBytes, saveGraphPng, saveGraphSnap, validExportName, validProjectTempDirectory, graphSnapshotDirectory,
    selectSnapshotProject, listGraphSnaps, readGraphSnap } from './viewer-export.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const maxBodyBytes = 1024 * 1024;
const mime = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json', '.map': 'application/json',
};

function json(response, status, body) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
}

/** A loopback-only query bridge and PNG saver. Database credentials stay in Studio. */
export function createViewerServer({ dist = resolve(root, 'dist/typedb-studio/browser'), devPort } = {}) {
    const clients = new Set();
    const projects = new Map();
    let latest;

    function send(client, request) {
        // Reconnect and replay the latest request instead of buffering indefinitely.
        if (client.writableLength > maxBodyBytes) return client.destroy();
        client.write(`id: ${request.id}\nevent: query\ndata: ${JSON.stringify(request)}\n\n`);
    }

    function allowed(request) {
        const port = server.address()?.port;
        const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
        return hosts.includes(request.headers.host)
            && (!request.headers.origin || request.headers.origin === `http://${request.headers.host}`)
            && !['cross-site', 'same-site'].includes(request.headers['sec-fetch-site']);
    }

    const server = createServer(async (request, response) => {
        if (!allowed(request)) return json(response, 403, { error: 'Use the local viewer origin.' });
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
            if (url.pathname === '/api/viewer/health' && request.method === 'GET') {
                return json(response, 200, { service: 'typedb-studio-bridge', pngExport: true, projectSnapshots: true, graphSnaps: true, snapLibrary: true, imageFolders: true, viewers: clients.size, latestRequestId: latest?.id ?? null });
            }
            const database = url.searchParams.get('database');
            const projectTempDirectory = url.searchParams.get('projectTempDirectory') ?? projects.get(database);
            if (url.pathname === '/api/viewer/project' && request.method === 'POST') {
                try {
                    const selected = await selectSnapshotProject(url.searchParams.get('path'), database);
                    projects.set(database, selected.projectTempDirectory);
                    return json(response, 200, selected);
                } catch (error) { return json(response, 400, { error: error.message }); }
            }
            if (['/api/viewer/snaps', '/api/viewer/snap'].includes(url.pathname) && request.method === 'GET') {
                try {
                    const directory = graphSnapshotDirectory(projectTempDirectory, database);
                    if (url.pathname.endsWith('/snap')) return json(response, 200, await readGraphSnap(directory, url.searchParams.get('filename')));
                    return json(response, 200, { database, projectTempDirectory, directory, imageDirectory: graphSnapshotDirectory(projectTempDirectory, database, 'imgs'), files: await listGraphSnaps(directory) });
                } catch (error) { return json(response, 400, { error: error.message }); }
            }
            if (['/api/viewer/export', '/api/viewer/snap'].includes(url.pathname) && request.method === 'POST') {
                const isSnap = url.pathname.endsWith('/snap');
                if (request.headers['content-type']?.split(';')[0].trim() !== (isSnap ? 'application/json' : 'image/png')) {
                    return json(response, 415, { error: isSnap ? 'Send application/json.' : 'Send image/png.' });
                }
                const baseName = url.searchParams.get('name');
                if (!validExportName(baseName)) return json(response, 400, { error: 'Invalid export name.' });
                const chunks = [];
                let size = 0;
                for await (const chunk of request) {
                    size += chunk.length;
                    if (size > maxPngBytes) return json(response, 413, { error: 'Graph PNG exceeds 64 MiB.' });
                    chunks.push(chunk);
                }
                try {
                    const directory = graphSnapshotDirectory(projectTempDirectory, database, isSnap ? 'snaps' : 'imgs');
                    const saved = await (isSnap ? saveGraphSnap : saveGraphPng)(directory, baseName, Buffer.concat(chunks));
                    return json(response, 201, saved);
                } catch (error) {
                    return json(response, 400, { error: error.message });
                }
            }
            if (url.pathname === '/api/viewer/events' && request.method === 'GET') {
                response.writeHead(200, {
                    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
                    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
                });
                response.write('retry: 1000\n\n');
                clients.add(response);
                if (latest) send(response, latest);
                const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
                heartbeat.unref();
                response.on('close', () => { clients.delete(response); clearInterval(heartbeat); });
                return;
            }
            if (url.pathname === '/api/viewer/query' && request.method === 'POST') {
                if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
                    return json(response, 415, { error: 'Send application/json.' });
                }
                let size = 0;
                const chunks = [];
                for await (const chunk of request) {
                    size += chunk.length;
                    if (size > maxBodyBytes) {
                        json(response, 413, { error: 'Query request exceeds 1 MiB.' });
                        return;
                    }
                    chunks.push(chunk);
                }
                let body;
                try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
                catch { return json(response, 400, { error: 'Invalid JSON.' }); }
                if (!body || typeof body.query !== 'string' || !body.query.trim()
                    || (body.database !== undefined && (typeof body.database !== 'string' || !body.database.trim()))
                    || (body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 100000))) {
                    return json(response, 400, { error: 'Expected query text, optional database, and optional integer limit (1–100000).' });
                }
                if (body.projectTempDirectory !== undefined && !validProjectTempDirectory(body.projectTempDirectory)) {
                    return json(response, 400, { error: 'Expected an absolute projectTempDirectory.' });
                }
                const execution = body.execution;
                if (execution !== undefined && (!execution || !['read', 'write', 'schema'].includes(execution.kind)
                    || !['success', 'error'].includes(execution.status)
                    || (execution.error !== undefined && (typeof execution.error !== 'string' || execution.error.length > 8000)))) {
                    return json(response, 400, { error: 'Invalid execution outcome.' });
                }
                latest = { id: randomUUID(), query: body.query, database: body.database, limit: body.limit ?? 1000,
                    ...(body.projectTempDirectory ? { projectTempDirectory: body.projectTempDirectory } : {}),
                    ...(execution ? { execution: { kind: execution.kind, status: execution.status, error: execution.error } } : {}) };
                if (body.database && body.projectTempDirectory) projects.set(body.database, body.projectTempDirectory);
                for (const client of clients) send(client, latest);
                return json(response, 202, { id: latest.id, viewers: clients.size, executionContext: true, projectSnapshots: true });
            }
            if (url.pathname.startsWith('/api/viewer/')) return json(response, 404, { error: 'Unknown viewer endpoint or method.' });
            if (url.pathname === '/viewer') {
                response.writeHead(302, { Location: '/query?nvim=1' });
                return response.end();
            }

            if (devPort) {
                const upstream = httpRequest({ hostname: '127.0.0.1', port: devPort, path: request.url,
                    method: request.method, headers: { ...request.headers, host: `127.0.0.1:${devPort}` } }, result => {
                    response.writeHead(result.statusCode, result.headers);
                    result.pipe(response);
                });
                upstream.on('error', () => {
                    if (response.headersSent || response.destroyed) return;
                    if (request.headers.accept?.includes('text/html')) {
                        response.writeHead(503, { 'Content-Type': 'text/html', Refresh: '1' });
                        response.end('<!doctype html><title>Starting Studio</title><p>TypeDB Studio is starting…</p>');
                    } else json(response, 503, { error: 'Angular is starting. Retry in a moment.' });
                });
                response.on('close', () => upstream.destroy());
                request.pipe(upstream);
                return;
            }
            if (!['GET', 'HEAD'].includes(request.method)) return json(response, 405, { error: 'Method not allowed.' });
            const pathname = decodeURIComponent(url.pathname);
            const file = resolve(dist, `.${pathname}`);
            if (!file.startsWith(resolve(dist) + sep)) {
                if (pathname !== '/') return json(response, 403, { error: 'Invalid path.' });
            }
            const info = await stat(file).catch(() => null);
            const target = info?.isFile() ? file : extname(pathname) ? null : resolve(dist, 'index.html');
            if (!target || !(await stat(target).catch(() => null))?.isFile()) {
                return json(response, 404, { error: 'File not found. Run pnpm build:viewer first, or use pnpm viewer:dev.' });
            }
            response.writeHead(200, { 'Content-Type': mime[extname(target)] ?? 'application/octet-stream',
                'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
            if (request.method === 'HEAD') return response.end();
            const stream = createReadStream(target);
            stream.on('error', () => response.destroy());
            stream.pipe(response);
        } catch (error) {
            if (!response.headersSent) json(response, 400, { error: 'Invalid request.' });
            else response.destroy();
        }
    });

    // Forward Angular's development socket too; application events use SSE separately.
    server.on('upgrade', (request, socket, head) => {
        if (!devPort || !allowed(request)) return socket.destroy();
        const upstream = httpRequest({ hostname: '127.0.0.1', port: devPort, path: request.url,
            headers: { ...request.headers, host: `127.0.0.1:${devPort}` } });
        upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
            socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
            if (head.length) upstreamSocket.write(head);
            if (upstreamHead.length) socket.write(upstreamHead);
            socket.pipe(upstreamSocket).pipe(socket);
            socket.on('error', () => upstreamSocket.destroy());
            upstreamSocket.on('error', () => socket.destroy());
            socket.on('close', () => upstreamSocket.destroy());
            upstreamSocket.on('close', () => socket.destroy());
        });
        upstream.on('error', () => socket.destroy());
        upstream.on('response', () => socket.destroy());
        upstream.end();
    });
    server.closeViewers = () => { for (const client of clients) client.end(); };
    return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const port = Number(process.env.TYPEDB_VIEWER_PORT || 1430);
    const dev = process.argv.includes('--dev');
    const devPort = Number(process.env.TYPEDB_VIEWER_DEV_PORT || 1431);
    if (![port, devPort].every(p => Number.isInteger(p) && p > 0 && p <= 65535) || port === devPort) {
        throw new Error('Choose distinct valid viewer and development ports.');
    }
    const server = createViewerServer({ devPort: dev ? devPort : undefined });
    let child;
    const stop = () => {
        child?.kill('SIGTERM');
        server.closeViewers();
        server.close();
        setTimeout(() => process.exit(), 1000).unref();
    };
    server.on('error', error => { console.error(error.message); child?.kill(); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => {
        console.log(`TypeDB Studio: http://localhost:${port}/query?nvim=1`);
        console.log(`Submit queries: POST http://localhost:${port}/api/viewer/query`);
        if (dev) {
            child = spawn(process.execPath, [resolve(root, 'node_modules/@angular/cli/bin/ng.js'),
                'serve', '--configuration', 'local', '--host', '127.0.0.1', '--port', String(devPort), '--ssl=false'],
                { cwd: root, stdio: 'inherit' });
            child.on('error', error => { console.error(error.message); process.exitCode = 1; stop(); });
            child.on('exit', code => { if (code) process.exitCode = code; stop(); });
        }
    });
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}
