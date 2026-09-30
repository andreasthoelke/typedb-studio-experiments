/** Shared by the browser and the local viewer server, so saved names and chip
 * labels agree. Titles are Neovim `# ─ ` headers; decoration is not content. */
export function cleanSourceTitle(title) {
    return String(title ?? '').replace(/^[\s─━—-]+|[\s─━—-]+$/gu, '');
}

/** Plain paragraph headers (`# 2. The source is kept, not trusted.`): the
 * leading words up to the first `,` `.` `;` `:` or dash are the title and the
 * rest of the line is the comment. A numeric prefix such as `2.` or `6a.` stays
 * in the title; `?` and `!` end the title and are kept. Mirrored in
 * contrib/nvim/typedb_graph.lua (`split_heading`). */
export function splitPlainHeading(line) {
    const text = String(line ?? '').trim(), prefix = /^\d+[a-z]?[.)]?\s+/u.exec(text)?.[0] ?? '';
    const match = /[,.;:](?=\s|$)|[?!](?=\s|$)|\s[—–]\s/u.exec(text.slice(prefix.length));
    if (!match) return { title: text, comment: '' };
    const end = prefix.length + match.index, keep = /[?!]/u.test(match[0]) ? 1 : 0;
    return { title: text.slice(0, end + keep).trim(), comment: text.slice(end + match[0].length).trim() };
}

/** A short, filesystem-safe snap base for a titled query: words cut to four
 * characters, joined with `-`, and bounded to about 28 characters at a word
 * boundary. The server appends `-<index>`, starting at 0. */
export function snapTitleBase(title) {
    const words = cleanSourceTitle(title).normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
        .map(word => [...word].slice(0, 4).join(''));
    let base = '';
    for (const word of words) {
        if (base && base.length + word.length + 1 > 28) break;
        base = base ? `${base}-${word}` : word;
    }
    return base;
}

/** The chip label for a titled snap filename, or null when the filename was
 * not derived from this title (older snaps keep their type abbreviation). */
export function titledSnapLabel(filename, title) {
    const base = snapTitleBase(title);
    const match = /^(.*)-(\d+)\.snap\.json$/u.exec(filename);
    return base && match && match[1] === base ? `${base.replaceAll('-', ' ')} ${match[2]}` : null;
}
