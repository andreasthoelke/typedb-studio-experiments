import { graphNodeHints } from './graph-navigation';

/** Local, visible-control hints. No extension, synthetic keystrokes or background clicks. */
export class UIHints {
    private entries: { label: string; target: HTMLElement; badge: HTMLElement }[] = [];
    private overlay: HTMLElement | null = null;
    private prefix = '';
    get active(): boolean { return !!this.overlay; }
    cancel = (): void => {
        this.overlay?.remove(); this.overlay = null; this.entries = []; this.prefix = '';
        window.removeEventListener('scroll', this.cancel, true);
        window.removeEventListener('resize', this.cancel);
        window.removeEventListener('blur', this.cancel);
        document.removeEventListener('visibilitychange', this.cancel);
        window.removeEventListener('pointerdown', this.cancel, true);
    };
    start(): void {
        this.cancel();
        const scopes = [...document.querySelectorAll<HTMLElement>('.cdk-overlay-pane')].filter(el => el.getBoundingClientRect().width > 0);
        const scope = scopes.filter(el => el.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')).at(-1) ?? document.body;
        const candidates = [...scope.querySelectorAll<HTMLElement>('button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="combobox"], [role="checkbox"], [role="tab"]')];
        const targets = candidates.filter(el => {
            if (el.matches(':disabled, [aria-disabled="true"]') || el.closest('[inert]')) return false;
            const r = el.getBoundingClientRect(), style = getComputedStyle(el);
            if (!r.width || !r.height || style.visibility !== 'visible' || style.display === 'none') return false;
            const x = Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2));
            const y = Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2));
            if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return false;
            const hit = document.elementFromPoint(x, y);
            return !!hit && el.contains(hit) && !candidates.some(other => other !== el && el.contains(other) && other.contains(hit));
        });
        if (!targets.length) return;
        this.overlay = document.createElement('div');
        this.overlay.className = 'studio-ui-hints';
        this.overlay.setAttribute('aria-label', 'Control hints: type a label, Escape to cancel');
        Object.assign(this.overlay.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647' });
        document.body.append(this.overlay);
        this.entries = graphNodeHints(targets.map((target, i) => {
            const r = target.getBoundingClientRect(); return { key: String(i), x: Math.max(0, r.left), y: Math.max(0, r.top) };
        })).map(hint => {
            const badge = document.createElement('span'); badge.textContent = hint.label;
            badge.dataset['hint'] = hint.label;
            Object.assign(badge.style, { position: 'absolute', left: `${hint.x}px`, top: `${hint.y}px`,
                background: '#ffe58a', color: '#171717', border: '1px solid #5e4b00', borderRadius: '3px',
                font: 'bold 12px monospace', lineHeight: '16px', padding: '0 3px' });
            this.overlay!.append(badge);
            return { label: hint.label, target: targets[Number(hint.key)], badge };
        });
        window.addEventListener('scroll', this.cancel, true);
        window.addEventListener('resize', this.cancel);
        window.addEventListener('blur', this.cancel);
        document.addEventListener('visibilitychange', this.cancel);
        window.addEventListener('pointerdown', this.cancel, true);
    }
    key(event: KeyboardEvent): void {
        event.preventDefault(); event.stopImmediatePropagation();
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
        if (event.key === 'Escape' || (event.ctrlKey && event.key === '[')) { this.cancel(); return; }
        if (event.repeat) return;
        if (event.ctrlKey || event.metaKey || event.altKey) { this.cancel(); return; }
        if (event.key === 'Backspace') this.prefix = this.prefix.slice(0, -1);
        else if (/^[a-z]$/i.test(event.key)) this.prefix += event.key.toLowerCase();
        else { this.cancel(); return; }
        const matches = this.entries.filter(entry => entry.label.startsWith(this.prefix));
        for (const entry of this.entries) entry.badge.hidden = !matches.includes(entry);
        const selected = matches.find(entry => entry.label === this.prefix);
        if (selected) {
            const target = selected.target; this.cancel();
            if (!target.isConnected || target.matches(':disabled, [aria-disabled="true"]')) return;
            target.focus({ preventScroll: true }); target.click();
        } else if (!matches.length) this.cancel();
    }
}
