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

// statement-level pass over a table data chunk:
// yields complete INSERT statements (possibly multi-line) and passes other lines through as-is
export function* statements(lines) {
    let insert = [];
    for (const line of lines) {
        switch (true) {
            case insert.length > 0 || line.startsWith("INSERT "):
                insert.push(line);
                if (line.trimEnd().endsWith(";")) {
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
