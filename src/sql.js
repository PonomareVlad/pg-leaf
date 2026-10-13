/**
 * Ядро pg-leaf: лексер plain-дампа pg_dump, сбор уникальных ключей таблиц
 * и разделение дампа на детерминированное дерево SQL-файлов.
 *
 * Снимок каноничен: повторный split результата join даёт байт-в-байт
 * то же дерево, поэтому дамп и снимок зеркалируют друг друга.
 */

// --- Лексер ---------------------------------------------------------------

/** Один SQL-токен за совпадение; последняя альтернатива ловит любой одиночный символ. */
const TOKEN = new RegExp(
  [
    /\s+|--[^\n]*|\/\*[\s\S]*?\*\//, // пробелы и комментарии
    /"(?:[^"]|"")*"/, // идентификатор в кавычках
    /[eE]'(?:[^'\\]|''|\\[\s\S])*'/, // строка с escape-последовательностями
    /'(?:[^']|'')*'/, // обычная строка
    /(\$[A-Za-z_]*\$)[\s\S]*?\1/, // долларовая строка
    /[A-Za-z_][A-Za-z0-9_$]*/, // слово
    /[0-9][0-9A-Za-z_.+-]*/, // число
    /[\s\S]/, // одиночный символ
  ]
    .map((part) => part.source)
    .join("|"),
  "y",
);

/** Тип токена по его тексту; null для пробелов и комментариев. */
function classify(text) {
  if (/^(\s|--|\/\*)/.test(text)) return null;
  if (text.startsWith('"')) return "identifier";
  if (/^([eE]?'|\$[A-Za-z_]*\$)/.test(text)) return "literal";
  if (/^[A-Za-z_]/.test(text)) return "word";
  if (/^[0-9]/.test(text)) return "number";
  return "symbol";
}

/** Снимает кавычки с идентификатора: `"a""b"` → `a"b`. */
const unquote = (text) => text.slice(1, -1).replaceAll('""', '"');

/** Сдвигает лексер за конец блочного комментария с учётом вложенности. */
function skipNested(sql, lexer, comment) {
  const bounds = /\/\*|\*\//g;
  bounds.lastIndex = lexer.lastIndex;
  let depth = comment.split("/*").length - comment.split("*/").length;
  while (depth) depth += bounds.exec(sql)[0] === "/*" ? 1 : -1;
  lexer.lastIndex = bounds.lastIndex;
}

const upper = (token) => token?.value?.toUpperCase();
const isName = (token) => token?.type === "word" || token?.type === "identifier";

/** PostgreSQL сворачивает не взятые в кавычки идентификаторы к нижнему регистру. */
const fold = (token) => (token.type === "word" ? token.value.toLowerCase() : token.value);

/**
 * Делит дамп на операторы по `;` верхнего уровня.
 * Возвращает массив { text, tokens }: text — исходный срез вместе с
 * предшествующими комментариями, tokens — токены самого оператора
 * (start и end — абсолютные смещения в дампе).
 * Блок данных `COPY ... FROM stdin;` читается целиком до строки `\.`.
 */
export function parse(sql) {
  const lexer = new RegExp(TOKEN.source, "y");
  const statements = [];
  let tokens = [];
  let start = 0;

  while (lexer.lastIndex < sql.length) {
    const from = lexer.lastIndex;
    const text = lexer.exec(sql)[0];
    if (text.startsWith("/*")) skipNested(sql, lexer, text);
    const type = classify(text);
    if (!type) continue;
    tokens.push({ type, value: type === "identifier" ? unquote(text) : text, start: from, end: lexer.lastIndex });
    if (text !== ";") continue;

    if (upper(tokens[0]) === "COPY" && tokens.some((token) => upper(token) === "STDIN")) {
      const terminator = sql.indexOf("\n\\.\n", lexer.lastIndex - 1);
      if (terminator === -1) throw new Error("Unterminated COPY FROM stdin block");
      lexer.lastIndex = terminator + 4;
    }
    statements.push({ text: sql.slice(start, lexer.lastIndex), tokens });
    tokens = [];
    start = lexer.lastIndex;
  }

  if (sql.slice(start).trim()) statements.push({ text: sql.slice(start), tokens });
  return statements;
}

// --- Разбор структур в токенах --------------------------------------------

/** Читает [схема.]таблица начиная с tokens[start]; схема по умолчанию public. */
function readName(tokens, start) {
  const parts = [fold(tokens[start])];
  let next = start + 1;
  while (tokens[next]?.value === ".") {
    parts.push(fold(tokens[next + 1]));
    next += 2;
  }
  const [schema, table] = parts.length > 1 ? parts.slice(-2) : ["public", parts[0]];
  return { schema, table, key: `${schema}.${table}`, next };
}

/** Индекс закрывающей скобки, парной открывающей tokens[open]. */
function findClose(tokens, open) {
  if (tokens[open]?.value !== "(") throw new Error("Expected an opening parenthesis");
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].value === "(") depth += 1;
    if (tokens[i].value === ")") depth -= 1;
    if (depth === 0) return i;
  }
  throw new Error("Unbalanced parentheses");
}

/** Делит содержимое скобок tokens[open]...close по запятым верхнего уровня. */
function splitList(tokens, open) {
  const close = findClose(tokens, open);
  const parts = [[]];
  let depth = 0;
  for (const token of tokens.slice(open + 1, close)) {
    if (token.value === "(") depth += 1;
    if (token.value === ")") depth -= 1;
    if (token.value === "," && depth === 0) parts.push([]);
    else parts.at(-1).push(token);
  }
  return { parts, close };
}

/** Список простых имён колонок `(a, b)` → { columns, close }, иначе null. */
function readColumns(tokens, open) {
  if (tokens[open]?.value !== "(") return null;
  const { parts, close } = splitList(tokens, open);
  if (!parts.every((part) => part.length === 1 && isName(part[0]))) return null;
  return { columns: parts.map((part) => fold(part[0])), close };
}

// --- Сбор уникальных ключей ------------------------------------------------

function tableFor(tables, key) {
  if (!tables.has(key)) tables.set(key, { primary: null, unique: [], notNull: new Set() });
  return tables.get(key);
}

/** Одно определение внутри CREATE TABLE: колонка либо табличное ограничение. */
function collectDefinition(part, info) {
  const i = upper(part[0]) === "CONSTRAINT" ? 2 : 0;
  if (upper(part[i]) === "PRIMARY") {
    const key = readColumns(part, i + 2);
    if (key) info.primary = key.columns;
    return;
  }
  if (upper(part[i]) === "UNIQUE") {
    const nullsNotDistinct = upper(part[i + 1]) === "NULLS";
    const key = readColumns(part, i + (nullsNotDistinct ? 4 : 1));
    if (key) info.unique.push({ columns: key.columns, nullsNotDistinct });
    return;
  }
  if (!isName(part[i])) return;
  const column = fold(part[i]);
  const modifiers = part.slice(i + 1).map(upper);
  if (modifiers.includes("NOT") && modifiers.includes("NULL")) info.notNull.add(column);
  if (modifiers.includes("PRIMARY")) info.primary = [column];
  else if (modifiers.includes("UNIQUE")) info.unique.push({ columns: [column], nullsNotDistinct: false });
}

/** CREATE TABLE: встроенные PRIMARY KEY, UNIQUE и NOT NULL. */
function collectCreateTable(tokens, words, tables) {
  let i = words.indexOf("TABLE") + 1;
  if (words[i] === "IF") i += 3; // IF NOT EXISTS
  const name = readName(tokens, i);
  if (tokens[name.next]?.value !== "(") return;
  const info = tableFor(tables, name.key);
  for (const part of splitList(tokens, name.next).parts) collectDefinition(part, info);
}

/** ALTER TABLE ... ADD [CONSTRAINT имя] PRIMARY KEY | UNIQUE (колонки). */
function collectAlterTable(tokens, words, tables) {
  if (!words.includes("ADD") || words.includes("FOREIGN")) return;
  const primary = words.includes("PRIMARY");
  if (!primary && !words.includes("UNIQUE")) return;
  const name = readName(tokens, words[2] === "ONLY" ? 3 : 2);
  const open = tokens.findIndex((token, i) => i > name.next && token.value === "(");
  const key = readColumns(tokens, open);
  if (!key) return;
  const info = tableFor(tables, name.key);
  if (primary) {
    info.primary = key.columns;
    for (const column of key.columns) info.notNull.add(column);
  } else {
    info.unique.push({ columns: key.columns, nullsNotDistinct: words.includes("DISTINCT") });
  }
}

/** CREATE UNIQUE INDEX ... ON таблица (колонки); частичные (WHERE) не подходят. */
function collectUniqueIndex(tokens, words, tables) {
  if (words.includes("WHERE")) return;
  const on = words.indexOf("ON");
  const name = readName(tokens, words[on + 1] === "ONLY" ? on + 2 : on + 1);
  const open = tokens.findIndex((token, i) => i > name.next && token.value === "(");
  const key = readColumns(tokens, open);
  if (!key) return;
  tableFor(tables, name.key).unique.push({ columns: key.columns, nullsNotDistinct: words.includes("DISTINCT") });
}

/**
 * Первый проход: уникальные ключи всех таблиц.
 * Нужен до раскладки записей, поскольку PRIMARY KEY обычно
 * объявляется в post-data — после самих данных таблицы.
 */
function collectKeys(statements) {
  const tables = new Map();
  for (const { tokens } of statements) {
    const words = tokens.map(upper);
    const head = words.slice(0, 3).join(" ");
    if (/^CREATE (UNLOGGED )?TABLE/.test(head)) collectCreateTable(tokens, words, tables);
    else if (/^ALTER TABLE/.test(head)) collectAlterTable(tokens, words, tables);
    else if (head === "CREATE UNIQUE INDEX") collectUniqueIndex(tokens, words, tables);
  }
  return tables;
}

/**
 * Ключ идентификации записи: PRIMARY KEY, иначе лексикографически первый
 * уникальный ключ, у которого NULL не нарушает уникальность
 * (все колонки NOT NULL либо NULLS NOT DISTINCT).
 */
function selectKey(info) {
  if (!info) return null;
  if (info.primary) return info.primary;
  const usable = info.unique
    .filter(({ columns, nullsNotDistinct }) => nullsNotDistinct || columns.every((column) => info.notNull.has(column)))
    .map(({ columns }) => columns)
    .sort();
  return usable[0] ?? null;
}

// --- Записи таблиц ----------------------------------------------------------

/**
 * Разбирает `INSERT INTO таблица (колонки) [OVERRIDING ... VALUE] VALUES (значения);`
 * с ровно одной строкой значений, либо `INSERT INTO таблица DEFAULT VALUES;`.
 * Значения — нетронутые срезы исходного SQL.
 */
function parseInsert(sql, tokens) {
  const name = readName(tokens, upper(tokens[1]) === "INTO" ? 2 : 1);
  if (upper(tokens[name.next]) === "DEFAULT") return { name, columns: [], values: [] };

  const columnList = readColumns(tokens, name.next);
  if (!columnList) throw new Error("INSERT must list its target columns");
  let i = columnList.close + 1;

  let overriding = "";
  if (upper(tokens[i]) === "OVERRIDING") {
    overriding = `OVERRIDING ${upper(tokens[i + 1])} VALUE `;
    i += 3;
  }

  if (upper(tokens[i]) !== "VALUES") throw new Error("INSERT must use VALUES");
  const { parts, close } = splitList(tokens, i + 1);
  if (tokens[close + 1]?.value !== ";") throw new Error("INSERT must contain exactly one VALUES row");
  if (parts.length !== columnList.columns.length) throw new Error("INSERT column and value counts do not match");

  const values = parts.map((part) => sql.slice(part[0].start, part.at(-1).end));
  return { name, columns: columnList.columns, values, overriding };
}

/** Экранирует идентификатор для каноничного вывода. */
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

/** Каноничный многострочный INSERT: одна колонка — одна строка. */
function formatInsert({ name, columns, values, overriding = "" }) {
  const target = `INSERT INTO ${quote(name.schema)}.${quote(name.table)}`;
  if (!columns.length) return `${target} DEFAULT VALUES;\n`;
  const block = (items) => `(\n  ${items.join(",\n  ")}\n)`;
  return `${target} ${block(columns.map(quote))} ${overriding}VALUES ${block(values)};\n`;
}

// --- Имена файлов ------------------------------------------------------------

/** SHA-256 значений ключа в однозначной length-prefixed сериализации; NULL кодируется отдельно. */
export function keyHash(values) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${values.length};`);
  for (const value of values) {
    hasher.update(/^null$/i.test(value) ? "N;" : `${Buffer.byteLength(value)}:${value};`);
  }
  return hasher.digest("hex");
}

/** Windows не допускает такие имена файлов и сравнивает пути без учёта регистра. */
const UNSAFE = /^(con|prn|aux|nul|com\d|lpt\d)$|[^a-z0-9_]/;

/** Человекочитаемое и переносимое имя директории схемы или таблицы. */
function component(name) {
  if (!UNSAFE.test(name)) return name;
  return `${name.toLowerCase().replace(/[^a-z0-9_]+/g, "_")}-${keyHash([name]).slice(0, 8)}`;
}

/** Путь файла записи: хеш-ключи раскладываются по префиксным директориям. */
function rowPath({ schema, table }, id) {
  const rows = `10-data/schemas/${component(schema)}/${component(table)}/rows`;
  if (typeof id === "number") return `${rows}/${String(id).padStart(12, "0")}.sql`;
  return `${rows}/${id.slice(0, 2)}/${id}.sql`;
}

// --- Разделение дампа ---------------------------------------------------------

/** Фаза восстановления оператора, если он её переключает, иначе null. */
function phaseOf(words) {
  const postData = ["INDEX", "UNIQUE", "TRIGGER", "RULE", "POLICY"];
  const constraint = ["CONSTRAINT", "FOREIGN", "VALIDATE"];
  if (words[0] === "CREATE" && postData.includes(words[1])) return "post";
  if (words[0] === "ALTER" && words[1] === "TABLE" && constraint.some((word) => words.includes(word))) return "post";
  if (words[0] === "COPY" || (words[0] === "SELECT" && words.includes("SETVAL"))) return "data";
  return null;
}

/** Кладёт запись в отдельный файл по хешу ключа, либо по порядковому номеру. */
function placeRow(files, row, tables, ordinals) {
  const key = selectKey(tables.get(row.name.key));
  let id;
  if (key && key.every((column) => row.columns.includes(column))) {
    id = keyHash(key.map((column) => row.values[row.columns.indexOf(column)]));
  } else {
    id = (ordinals.get(row.name.key) ?? 0) + 1;
    ordinals.set(row.name.key, id);
  }
  const path = rowPath(row.name, id);
  if (files.has(path)) throw new Error(`Duplicate unique key or hash collision: ${path}`);
  files.set(path, formatInsert(row));
}

/**
 * Делит plain-дамп на дерево файлов снимка.
 *
 * Каждый INSERT попадает в отдельный файл по хешу уникального ключа или
 * порядковому номеру, остальные операторы — по фазам восстановления:
 * 00-pre.sql → записи таблиц → 10-data/90-other.sql → 20-post.sql
 * (порядок задаётся лексикографической сортировкой путей при join).
 *
 * @param {string} sql plain-дамп pg_dump (по одному INSERT на запись)
 * @returns {Map<string, string>} относительный путь → содержимое файла
 */
export function splitDump(sql) {
  const statements = parse(sql);
  const tables = collectKeys(statements);

  const files = new Map();
  const phases = { pre: [], data: [], post: [] };
  const ordinals = new Map();
  let phase = "pre";

  for (const { text, tokens } of statements) {
    const words = tokens.map(upper);
    if (words[0] === "INSERT") {
      phase = "data";
      placeRow(files, parseInsert(sql, tokens), tables, ordinals);
    } else {
      phase = phaseOf(words) ?? phase;
      if (text.trim()) phases[phase].push(text.trim());
    }
  }

  if (phases.pre.length) files.set("00-pre.sql", `${phases.pre.join("\n\n")}\n`);
  if (phases.data.length) files.set("10-data/90-other.sql", `${phases.data.join("\n\n")}\n`);
  if (phases.post.length) files.set("20-post.sql", `${phases.post.join("\n\n")}\n`);
  return files;
}
