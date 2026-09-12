import { Injectable } from "@angular/core";
import { BehaviorSubject } from "rxjs";
import { GraphSnap, parseGraphSnap } from "../framework/util/graph-snap";

export interface GraphSnapshotContext { database: string; projectTempDirectory: string; }
const STORAGE_KEY = "typedb-studio-snapshot-projects";

/** Remember the last source project per database for schema and manually opened views. */
@Injectable({ providedIn: "root" })
export class GraphSnapshotService {
    readonly opened$ = new BehaviorSubject<GraphSnap | null>(null);

    async open(file: File): Promise<void> {
        if (file.size > 64 * 1024 * 1024) throw new Error("Snap exceeds 64 MiB.");
        this.opened$.next(parseGraphSnap(await file.text()));
    }

    private projects = new Map<string, string>();

    constructor() {
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
