import { createServer, request as httpRequest } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createRunExecutor, prepareRun } from './viewer-run.mjs';
import { maxPngBytes, saveGraphPng, saveGraphSnap, validExportName, validProjectTempDirectory, graphSnapshotDirectory,
    selectSnapshotProject, listGraphSnaps, readGraphSnap, deleteGraphSnap } from './viewer-export.mjs';

function validSource(s) {
    return s && typeof s.path === 'string' && s.path.startsWith('/') && !s.path.includes('\0')
        && Number.isInteger(s.line) && s.line > 0 && s.line <= 10000000
        && ['anchor', 'title', 'comment', 'query'].every(k => typeof s[k] === 'string' && s[k].length <= 1024 * 1024)
        && (s.server === undefined || (typeof s.server === 'string' && s.server.length < 1000 && !s.server.includes('\0')));
}
function openSource(source) {
    // argv + a quoted JSON value: paths/anchors are never Ex or Lua code.
    const payload = JSON.stringify(source).replaceAll("'", "''");
    const lua = `(function() local s=vim.fn.json_decode(_A); vim.cmd('edit '..vim.fn.fnameescape(s.path)); local lines=vim.api.nvim_buf_get_lines(0,0,-1,false); local best=nil; for i,line in ipairs(lines) do if line==s.anchor and (not best or math.abs(i-s.line)<math.abs(best-s.line)) then best=i end end; vim.api.nvim_win_set_cursor(0,{best or math.min(s.line,#lines),0}); vim.cmd('normal! zz'); return true end)()`;
    const expression = `luaeval('${lua.replaceAll("'", "''")}', '${payload}')`;
    return new Promise((resolve, reject) => {
        const child = spawn(process.env.TYPEDB_NVIM_BINARY || (existsSync('/opt/homebrew/bin/nvim') ? '/opt/homebrew/bin/nvim' : 'nvim'), ['--server', source.server, '--remote-expr', expression], { stdio: ['ignore', 'ignore', 'pipe'] });
        let error = ''; child.stderr.on('data', chunk => error += chunk);
        const timer = setTimeout(() => { child.kill(); reject(new Error('Neovim did not answer.')); }, 5000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(error || 'Could not open source in Neovim.')); });
    });
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const maxBodyBytes = 1024 * 1024;
const mime = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json', '.map': 'application/json',
};

/** `<c-w>` motions that leave the page are handed to the window manager, the
 *  same escalation vim-tmux-navigator performs at a pane edge. Hammerspoon
 *  resolves them geometrically, so nothing here knows about the user's column
 *  layout. Directions are a closed set and the Lua is a fixed string per
 *  direction: nothing from the request is ever interpolated into it. */
const windowFocusDirections = ['west', 'east', 'north', 'south', 'far-west', 'far-east', 'previous'];
/** `contrib/hammerspoon/typedb_panes.lua` defines `typedbFocusWindow` and adds
 *  the cross-window history that `previous` needs. Without it the cardinal
 *  directions still work off Hammerspoon's own geometric focus, so the only
 *  setup a working install requires is Hammerspoon itself. */
const hammerspoonMethod = compass => `focusWindow${compass[0].toUpperCase()}${compass.slice(1)}`;
/** The fallback repeats the step for a `far-` motion, bounded so a window
 *  manager that keeps reporting a move can never spin. */
const hammerspoonDirection = (direction, compass, far) =>
    `if typedbFocusWindow then typedbFocusWindow('${direction}') else ` +
    `for _ = 1, ${far ? 8 : 1} do local w = hs.window.focusedWindow(); if not w then break end; ` +
    `w:${hammerspoonMethod(compass)}(nil, false, true); local n = hs.window.focusedWindow(); ` +
    `if not n or n:id() == w:id() then break end end end`;
const hammerspoonLua = {
    west: hammerspoonDirection('west', 'west', false),
    east: hammerspoonDirection('east', 'east', false),
    north: hammerspoonDirection('north', 'north', false),
    south: hammerspoonDirection('south', 'south', false),
    'far-west': hammerspoonDirection('far-west', 'west', true),
    'far-east': hammerspoonDirection('far-east', 'east', true),
    previous: "if typedbFocusWindow then typedbFocusWindow('previous') end",
};
const hammerspoonCandidates = ['/opt/homebrew/bin/hs', '/usr/local/bin/hs'];

/** Reported once, because a missing `hs.ipc` fails every single motion and a
 *  line per keystroke would bury the rest of `:TypeDBGraphLog`. */
let reportedFocusFailure = false;

/** Fire-and-forget: the browser has nothing to do with the result, and waiting
 *  on a process spawn would add latency to a keystroke. */
function focusWindow(direction) {
    if (process.platform !== 'darwin') return { focused: false, reason: 'Window focus escalation is macOS-only.' };
    const hs = hammerspoonCandidates.find(path => existsSync(path));
    if (!hs) return { focused: false, reason: 'Install Hammerspoon and its `hs` command line tool.' };
    const child = spawn(hs, ['-c', hammerspoonLua[direction]], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += chunk; });
    // Best-effort: an edge motion must never fail a keystroke, but a setup
    // mistake that makes every motion do nothing should still be findable.
    child.on('error', error => warnFocusFailure(error.message));
    child.on('close', code => { if (code !== 0) warnFocusFailure(stderr.trim() || `hs exited with ${code}`); });
    return { focused: true };
}

function warnFocusFailure(detail) {
    if (reportedFocusFailure) return;
    reportedFocusFailure = true;
    console.warn(`TypeDB Studio: window focus escalation failed (${detail}). `
        + 'Hammerspoon must be running with `require("hs.ipc")` in its init.lua.');
}

function json(response, status, body) {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
}

/** Loopback bridge; the executor's credentials come only from server configuration. */
export function createViewerServer({ dist = resolve(root, 'dist/typedb-studio/browser'), devPort, windowFocus = focusWindow,
    runExecutor = createRunExecutor() } = {}) {
    const clients = new Set();
    const projects = new Map();
    let latest;
    const runs = new Map();
    let runQueue = Promise.resolve();

    function send(client, request, event = 'query') {
        // Reconnect and replay the latest request instead of buffering indefinitely.
        if (client.writableLength > maxBodyBytes) return client.destroy();
        client.write(`id: ${request.id}\nevent: ${event}\ndata: ${JSON.stringify(request)}\n\n`);
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
                return json(response, 200, { service: 'typedb-studio-bridge', structuredRuns: true, viewerControls: true, caretNavigation: true, pngExport: true, projectSnapshots: true, graphSnaps: true, snapLibrary: true, imageFolders: true, titledSnaps: true, windowFocus: true, viewers: clients.size, latestRequestId: latest?.id ?? null });
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
            if (url.pathname === '/api/viewer/snap' && request.method === 'DELETE') {
                try {
                    const directory = graphSnapshotDirectory(projectTempDirectory, database);
                    return json(response, 200, await deleteGraphSnap(directory, url.searchParams.get('filename')));
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
                    const saved = await (isSnap ? saveGraphSnap : saveGraphPng)(directory, baseName, Buffer.concat(chunks),
                        url.searchParams.get('digits') === '1' ? 1 : 2);
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
            if (['/api/viewer/run', '/api/viewer/query', '/api/viewer/caret', '/api/viewer/control', '/api/viewer/focus', '/api/viewer/source'].includes(url.pathname) && request.method === 'POST') {
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
                if (url.pathname === '/api/viewer/source') {
                    const s = body?.sourceLocation;
                    if (!validSource(s) || !s.server || !s.server.startsWith('/') || !existsSync(s.server))
                        return json(response, 400, { error: 'The source Neovim session is unavailable. Send the snippet again from Neovim.' });
                    try { await openSource(s); return json(response, 200, { opened: true }); }
                    catch (error) { return json(response, 400, { error: error.message }); }
                }
                if (url.pathname === '/api/viewer/focus') {
                    if (!body || !windowFocusDirections.includes(body.direction)) {
                        return json(response, 400, { error: `Expected direction one of ${windowFocusDirections.join(', ')}.` });
                    }
                    return json(response, 202, { direction: body.direction, ...windowFocus(body.direction) });
                }
                if (url.pathname === '/api/viewer/control') {
                    const commands = ['centreCaret', 'caretTop', 'caretBottom', 'caretLeft', 'caretRight',
                        'panLeft', 'panRight', 'panUp', 'panDown', 'zoomIn', 'zoomOut', 'focus', 'back', 'relayout', 'snap'];
                    if (!body || !commands.includes(body.command)
                        || (body.database !== undefined && (typeof body.database !== 'string' || !body.database.trim()))
                        || (body.projectTempDirectory !== undefined && !validProjectTempDirectory(body.projectTempDirectory))) {
                        return json(response, 400, { error: 'Expected a viewer command, optional database and absolute projectTempDirectory.' });
                    }
                    const control = { id: randomUUID(), command: body.command,
                        ...(body.database ? { database: body.database } : {}),
                        ...(body.projectTempDirectory ? { projectTempDirectory: body.projectTempDirectory } : {}) };
                    for (const client of clients) send(client, control, 'control');
                    return json(response, 202, { id: control.id, viewers: clients.size, viewerControls: true });
                }
                if (url.pathname === '/api/viewer/caret') {
                    if (!body || typeof body.source !== 'string' || !body.source.trim()
                        || !Number.isInteger(body.line) || body.line < 0 || body.line >= body.source.split('\n').length
                        || !Number.isInteger(body.column) || body.column < 0 || body.column > body.source.split('\n')[body.line].length
                        || typeof body.schemaOnly !== 'boolean'
                        || (body.database !== undefined && (typeof body.database !== 'string' || !body.database.trim()))) {
                        return json(response, 400, { error: 'Expected source, zero-based line/column, schemaOnly, and optional database.' });
                    }
                    const caret = { id: randomUUID(), source: body.source, line: body.line, column: body.column,
                        schemaOnly: body.schemaOnly, ...(body.database ? { database: body.database } : {}) };
                    // Caret gestures are transient. A new tab/reconnect must not
                    // replay an old jump or replace the latest executable query.
                    for (const client of clients) send(client, caret, 'caret');
                    return json(response, 202, { id: caret.id, viewers: clients.size, caretNavigation: true });
                }
                if (!body || typeof body.query !== 'string' || !body.query.trim()
                    || (body.database !== undefined && (typeof body.database !== 'string' || !body.database.trim()))
                    || (body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 100000))) {
                    return json(response, 400, { error: 'Expected query text, optional database, and optional integer limit (1–100000).' });
                }
                if (body.sourceLocation !== undefined && !validSource(body.sourceLocation)) return json(response, 400, { error: 'Invalid source location.' });
                if (body.projectTempDirectory !== undefined && !validProjectTempDirectory(body.projectTempDirectory)) {
                    return json(response, 400, { error: 'Expected an absolute projectTempDirectory.' });
                }
                if (url.pathname === '/api/viewer/run') {
                    if (!body.database || typeof body.runId !== 'string' || !/^[\w-]{16,100}$/.test(body.runId)
                        || body.execution !== undefined || (body.publish !== undefined && typeof body.publish !== 'boolean')
                        || (body.schemaMode !== undefined && !['define', 'redefine', 'undefine'].includes(body.schemaMode))) {
                        return json(response, 400, { error: 'Expected database, unique runId (16–100 characters), and optional schemaMode; execution is server-owned.' });
                    }
                    try { prepareRun(body.query, body.schemaMode); }
                    catch (error) { return json(response, 400, { error: error.message }); }
                    const input = { runId: body.runId, query: body.query, database: body.database, limit: body.limit ?? 1000,
                        sourceLocation: body.sourceLocation, schemaMode: body.schemaMode, publish: body.publish !== false, projectTempDirectory: body.projectTempDirectory };
                    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
                    let entry = runs.get(body.runId);
                    if (entry && entry.fingerprint !== fingerprint) return json(response, 409, { error: 'runId already belongs to another request.' });
                    if (!entry) {
                        // Retain IDs for the server lifetime, even after dropping heavy results.
                        // Never execute an old ID again because a response cache was evicted.
                        if (runs.size >= 10000) return json(response, 503, { error: 'Run ID capacity reached; restart the bridge before another evaluation.' });
                        entry = { fingerprint };
                        runs.set(body.runId, entry);
                        entry.promise = runQueue.then(async () => {
                            const completed = await runExecutor(input);
                            if (body.projectTempDirectory) projects.set(body.database, body.projectTempDirectory);
                            if (input.publish) {
                                latest = { ...completed };
                                delete latest.lines;
                                for (const client of clients) send(client, latest);
                            }
                            return completed;
                        });
                        runQueue = entry.promise.catch(() => {});
                        entry.promise.finally(() => {
                            entry.done = true;
                            const cached = [...runs.values()].filter(e => e.done && e.promise);
                            for (const old of cached.slice(0, Math.max(0, cached.length - 20))) old.promise = null;
                        }).catch(() => {});
                    }
                    if (!entry.promise) return json(response, 410, { error: 'This run was already processed; its result has expired. It will not execute again.' });
                    try { return json(response, 200, await entry.promise); }
                    catch { return json(response, 500, { error: 'Run processing failed after acceptance. Execution outcome may be unknown; do not automatically retry.' }); }
                }
                const execution = body.execution;
                if (execution !== undefined && (!execution || !['read', 'write', 'schema'].includes(execution.kind)
                    || !['success', 'error'].includes(execution.status)
                    || (execution.error !== undefined && (typeof execution.error !== 'string' || execution.error.length > 8000)))) {
                    return json(response, 400, { error: 'Invalid execution outcome.' });
                }
                latest = { sourceLocation: body.sourceLocation, id: randomUUID(), query: body.query, database: body.database, limit: body.limit ?? 1000,
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
