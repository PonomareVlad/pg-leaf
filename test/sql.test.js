import {expect, test} from "bun:test";
import {columns, join, lines, split, statements, unformat, uniques, values} from "../src/sql.js";

const dump = await Bun.file(new URL("../fixtures/dump.sql", import.meta.url)).text();

test("split produces header, table data and footer chunks", () => {
    const chunks = split(dump);
    expect(chunks.map(({kind}) => kind)).toEqual(["header", "table", "table", "table", "table", "footer"]);
    expect(chunks.filter(({kind}) => kind === "table").map(({name}) => name))
        .toEqual(["logs", "orders", "products", "users"]);
});

test("table chunks start with their comment block and keep INSERT data", () => {
    const [users] = split(dump).filter(({name}) => name === "users");
    expect(users.lines[0].trimEnd()).toBe("--");
    expect(users.lines[1]).toStartWith("-- Data for Name: users; Type: TABLE DATA;");
    expect(users.lines.join("")).toContain("INSERT INTO public.users");
});

test("join restores chunks in the original order", () => {
    expect(join(split(dump))).toBe(dump);
});

test("roundtrip is lossless for dumps without table data", () => {
    const schemaOnly = "--\n-- Name: users; Type: TABLE; Schema: public; Owner: postgres\n--\n\nCREATE TABLE users ();\n";
    expect(split(schemaOnly).map(({kind}) => kind)).toEqual(["header"]);
    expect(join(split(schemaOnly))).toBe(schemaOnly);
});

test("statements yields complete INSERTs and passes other lines through", () => {
    const [logs] = split(dump).filter(({name}) => name === "logs");
    const parsed = [...statements(logs.lines)];
    const inserts = parsed.filter(({kind}) => kind === "insert").map(({text}) => text);
    expect(inserts).toEqual([
        "INSERT INTO public.logs VALUES ('ping');\n",
        "INSERT INTO public.logs VALUES ('ping');\n",
        "INSERT INTO public.logs VALUES ('pong');\n",
        "INSERT INTO public.logs VALUES ('first line;\nsecond line');\n"
    ]);
    expect(parsed.map(({text}) => text).join("")).toBe(logs.lines.join(""));
});

test("statements keeps multi-line INSERTs intact", () => {
    const lines = ["INSERT INTO public.notes VALUES ('line one\n", "line two');\n", "\n"];
    expect([...statements(lines)]).toEqual([
        {kind: "insert", text: "INSERT INTO public.notes VALUES ('line one\nline two');\n"},
        {kind: "other", text: "\n"}
    ]);
});

test("statements ignores `;` at line end inside a string literal", () => {
    const lines = ["INSERT INTO public.notes VALUES ('ends with;\n", "continues');\n"];
    expect([...statements(lines)]).toEqual([
        {kind: "insert", text: "INSERT INTO public.notes VALUES ('ends with;\ncontinues');\n"}
    ]);
});

test("unformat collapses formatting whitespace but preserves string literals", () => {
    expect(unformat("INSERT INTO\n  public.users\nVALUES\n  (1, 'Alice', NULL);\n"))
        .toBe("INSERT INTO public.users VALUES (1, 'Alice', NULL);");
    expect(unformat("INSERT INTO\n  public.t\nVALUES\n  (\n    1,\n    'a\nb;  c',\n    2\n  );"))
        .toBe("INSERT INTO public.t VALUES (1, 'a\nb;  c', 2);");
});

test("columns extracts column order from CREATE TABLE statements", () => {
    const tables = columns(lines(dump));
    expect(tables["public.users"]).toEqual(["id", "name", "email"]);
    expect(tables["public.logs"]).toEqual(["message"]);
});

test("uniques prefers a primary key over UNIQUE constraints", () => {
    const keys = uniques(lines(dump));
    expect(keys["public.users"]).toEqual(["id"]);
    expect(keys["public.orders"]).toEqual(["id"]);
    expect(keys["public.logs"]).toBeUndefined();
});

test("values splits a positional INSERT at top-level separators only", () => {
    expect(values("INSERT INTO public.users VALUES (1, 'O''Hara, Jr.', NULL);\n"))
        .toEqual(["1", "'O''Hara, Jr.'", "NULL"]);
    expect(values("INSERT INTO public.notes VALUES ('a\nb', 2);")).toEqual(["'a\nb'", "2"]);
});
