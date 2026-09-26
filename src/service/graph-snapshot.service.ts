import { Injectable } from "@angular/core";
import { BehaviorSubject, Subject } from "rxjs";
import { GraphSnap, parseGraphSnap } from "../framework/util/graph-snap";

export interface GraphSnapshotContext { database: string; projectTempDirectory: string; }
export interface SnapSummary { entities: number; relations: number; attributes: number; types: number; shape: "instances" | "types" | "mixed" | "empty"; }
export interface SavedGraphSnap { filename: string; modifiedAt: string; bytes: number; kind: "data" | "schema" | "unknown"; nodeCount?: number; abbreviation?: string; summary?: SnapSummary; }
export interface GraphSnapLibrary extends GraphSnapshotContext { directory: string; imageDirectory: string; files: SavedGraphSnap[]; }
const STORAGE_KEY = "typedb-studio-snapshot-projects";

/** Remember the last source project per database for schema and manually opened views. */
@Injectable({ providedIn: "root" })
export class GraphSnapshotService {
    readonly schemaContext$ = new Subject<{ id: string; query: string; database: string; limit: number; projectTempDirectory?: string }>();
    private contextChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("typedb-studio-schema-context");

    notifySchemaContext(snap: GraphSnap): void {
        if (snap.database && snap.query.trim()) this.contextChannel?.postMessage({
            id: crypto.randomUUID(), query: snap.query, database: snap.database, limit: 1000,
            projectTempDirectory: snap.project?.projectTempDirectory,
        });
    }

    readonly opened$ = new BehaviorSubject<GraphSnap | null>(null);
    activeFile: (GraphSnapshotContext & { filename: string }) | null = null;

    async open(file: File): Promise<GraphSnap> {
        if (file.size > 64 * 1024 * 1024) throw new Error("Snap exceeds 64 MiB.");
        const snap = parseGraphSnap(await file.text());
        return snap;
    }

    async request<T>(endpoint: string, params: Record<string, string>, options?: RequestInit): Promise<T> {
        let response: Response;
        try { response = await fetch(`/api/viewer/${endpoint}?${new URLSearchParams(params)}`, options); }
        catch { throw new Error("Cannot reach the local viewer. Start it in Neovim and open http://localhost:1430."); }
        if (response.status === 404 || !response.headers.get("Content-Type")?.includes("application/json")) {
            throw new Error("Start or restart the local viewer server in Neovim, then open http://localhost:1430.");
        }
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not access the project snaps folder.");
        return result as T;
    }

    async list(database: string, context?: GraphSnapshotContext): Promise<GraphSnapLibrary> {
        const library = await this.request<GraphSnapLibrary>("snaps", { database, ...context });
        return library;
    }

    async selectProject(database: string, path: string): Promise<GraphSnapshotContext> {
        const selected = await this.request<GraphSnapshotContext>("project", { database, path }, { method: "POST" });
        return this.remember(database, selected.projectTempDirectory);
    }

    async openSaved(context: GraphSnapshotContext, filename: string): Promise<GraphSnap> {
        const snap = parseGraphSnap(JSON.stringify(await this.request("snap", { ...context, filename })));
        // An archive moved into another project should continue saving beside that archive.
        snap.project = context;
        return snap;
    }

    private projects = new Map<string, string>();

    constructor() {
        if (this.contextChannel) this.contextChannel.onmessage = event => {
            const value = event.data;
            if (value && typeof value.id === "string" && typeof value.query === "string" && typeof value.database === "string") this.schemaContext$.next(value);
        };
        try {
            const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
            if (Array.isArray(saved)) for (const entry of saved) {
                if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
                    this.projects.set(entry[0], entry[1]);
                }
            }
        } catch { /* Storage is optional. */ }
    }

    remember(database: string, projectTempDirectory: string): GraphSnapshotContext {
        this.projects.set(database, projectTempDirectory);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.projects])); } catch { /* Storage is optional. */ }
        return { database, projectTempDirectory };
    }

    forDatabase(database: string | undefined | null): GraphSnapshotContext | undefined {
        const directory = database ? this.projects.get(database) : undefined;
        return database && directory ? { database, projectTempDirectory: directory } : undefined;
    }
}
