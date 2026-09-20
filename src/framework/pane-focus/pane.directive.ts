/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Directive, ElementRef, Input, OnDestroy, OnInit, inject } from "@angular/core";
import type { PaneId } from "../util/pane-focus";
import { PaneFocusService } from "../../service/pane-focus.service";

/** Marks a region as a `<c-w>` navigation target.
 *
 *  `tsPaneScroller` names the element that should actually receive focus,
 *  so Ctrl-e/y can scroll the pane's own container after `<c-w>e` while
 *  graph caret motions remain available. It is looked up lazily
 *  on each focus, since docking and tab switches rebuild these subtrees. */
@Directive({
    selector: "[tsPane]",
    standalone: true,
})
export class PaneDirective implements OnInit, OnDestroy {
    @Input({ required: true, alias: "tsPane" }) paneId!: PaneId;
    @Input() tsPaneScroller = "";

    private readonly host = inject(ElementRef<HTMLElement>);
    private readonly service = inject(PaneFocusService);

    ngOnInit(): void {
        const element = this.host.nativeElement as HTMLElement;
        this.service.register(this.paneId, element, () =>
            this.tsPaneScroller ? element.querySelector<HTMLElement>(this.tsPaneScroller) : null);
    }

    ngOnDestroy(): void {
        this.service.unregister(this.paneId, this.host.nativeElement as HTMLElement);
    }
}
