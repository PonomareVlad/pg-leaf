// Streaming line-by-line state machine over pg_dump section comments.
// States: header → table data (one chunk per table) → footer.

const SIGNATURE = /^-- (?:Data for )?Name: (?<name>[^;]+); Type: (?<type>[^;]+); Schema: (?<schema>[^;]*); Owner:/;

const OPENER = /^--\s*$/;

export const signature = line => line.match(SIGNATURE)?.groups;

export const lines = sql => sql.split(/(?<=\n)/);

// pg_dump prefixes every section comment with a bare `--` line —
// move it from the previous chunk so each chunk starts with its full comment block
const reopen = (previous, line) =>
    OPENER.test(previous.at(-1) ?? "") ? [previous.pop(), line] : [line];

export const split = sql => {
    const chunks = [{kind: "header", lines: []}];
    const last = () => chunks.at(-1);
    for (const line of lines(sql)) {
        const meta = signature(line);
        switch (true) {
            case meta?.type === "TABLE DATA":
                chunks.push({kind: "table", ...meta, lines: reopen(last().lines, line)});
                break;
            case Boolean(meta) && last().kind === "table":
                chunks.push({kind: "footer", lines: reopen(last().lines, line)});
                break;
            default:
                last().lines.push(line);
        }
    }
    return chunks;
};

export const join = chunks => chunks.map(({lines}) => lines.join("")).join("");

// statement-level pass over a table data chunk: yields complete INSERT statements and
// passes other lines through as-is; quote parity ignores `;` inside multi-line string literals
export function* statements(lines) {
    let insert = [], open = false;
    for (const line of lines) {
        switch (true) {
            case insert.length > 0 || line.startsWith("INSERT "):
                insert.push(line);
                open = (open + (line.match(/'/g)?.length ?? 0)) % 2 > 0;
                if (!open && line.trimEnd().endsWith(";")) {
                    yield {kind: "insert", text: insert.join("")};
                    insert = [];
                }
                break;
            default:
                yield {kind: "other", text: line};
        }
    }
    if (insert.length) yield {kind: "insert", text: insert.join("")};
}

// collapse formatting whitespace outside string literals back into a single-line statement
export const unformat = sql => {
    let result = "", quoted = false, space = false;
    for (const char of sql) {
        switch (true) {
            case !quoted && /\s/.test(char):
                space = true;
                break;
            default:
                if (space && result && !result.endsWith("(") && char !== ")") result += " ";
                [space, quoted] = [false, char === "'" ? !quoted : quoted];
                result += char;
        }
    }
    return result;
};

const unquote = ident => ident.replaceAll('"', "");

const NON_COLUMN = /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE|LIKE)$/;

// column order per table from CREATE TABLE statements
export const columns = lines => {
    const tables = {};
    let current;
    for (const line of lines) {
        const create = line.trimEnd().match(/^CREATE(?: UNLOGGED)? TABLE (?<table>\S+) \($/);
        switch (true) {
            case Boolean(create):
                current = tables[unquote(create.groups.table)] = [];
                break;
            case line.startsWith(")"):
                current = undefined;
                break;
            case Boolean(current): {
                const [ident] = line.trim().match(/^"[^"]+"|^\S+/) ?? [];
                if (ident && !NON_COLUMN.test(ident)) current.push(unquote(ident));
            }
        }
    }
    return tables;
};

// unique key columns per table from PRIMARY KEY / UNIQUE constraints; a primary key wins over earlier UNIQUEs
export const uniques = lines => {
    const keys = {};
    let table;
    for (const line of lines) {
        table = unquote(line.trimEnd().match(/^ALTER TABLE ONLY (?<table>\S+)$/)?.groups.table ?? table ?? "");
        const constraint = line.match(/^\s+ADD CONSTRAINT \S+ (?<kind>PRIMARY KEY|UNIQUE) \((?<cols>[^)]+)\)/);
        if (constraint && table && (constraint.groups.kind === "PRIMARY KEY" || !keys[table]))
            keys[table] = constraint.groups.cols.split(", ").map(unquote);
    }
    return keys;
};

// scalar values of a positional single-row INSERT, split at top-level `, ` separators
export const values = insert => {
    const text = insert.slice(insert.indexOf("VALUES (") + 8, insert.lastIndexOf(")"));
    const result = [""];
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        switch (true) {
            case quoted && char === "'" && text[i + 1] === "'":
                result[result.length - 1] += "''";
                i++;
                break;
            case char === "'":
                quoted = !quoted;
                result[result.length - 1] += char;
                break;
            case !quoted && char === "," && text[i + 1] === " ":
                result.push("");
                i++;
                break;
            default:
                result[result.length - 1] += char;
        }
    }
    return result;
};
