/**
 * Ядро pg-leaf: потоковый лексер plain-дампа pg_dump, сбор уникальных
 * ключей таблиц и разделение дампа на детерминированное дерево SQL-файлов.
 *
 * Дамп обрабатывается в два прохода потоком операторов: память ограничена
 * размером одного оператора, а не всего дампа. Комментарии сохраняются
 * без потерь: в pre-/post-data они остаются рядом со своими операторами,
 * в data-сегменте выделяются в отдельные чанки по пути парсинга.
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

/** Сдвигает лексер за конец блочного комментария с учётом вложенности; false — конец в следующем чанке. */
function skipNested(sql, lexer, comment) {
  const bounds = /\/\*|\*\//g;
  bounds.lastIndex = lexer.lastIndex;
  let depth = comment.split("/*").length - comment.split("*/").length;
  while (depth) {
    const match = bounds.exec(sql);
    if (!match) return false;
    depth += match[0] === "/*" ? 1 : -1;
  }
  lexer.lastIndex = bounds.lastIndex;
  return true;
}

const upper = (token) => token?.value?.toUpperCase();
const isName = (token) => token?.type === "word" || token?.type === "identifier";

/** PostgreSQL сворачивает не взятые в кавычки идентификаторы к нижнему регистру. */
const fold = (token) => (token.type === "word" ? token.value.toLowerCase() : token.value);

// --- Потоковое чтение операторов -------------------------------------------

/**
 * Делит поток текста на операторы по `;` верхнего уровня.
 * Источник — любой (async-)итератор строк или байтов; буфер держит не больше
 * одного оператора. Каждый оператор отдаётся как { text, tokens }:
 * text — исходный срез вместе с предшествующими комментариями (trivia),
 * tokens — токены оператора со смещениями относительно начала text.
 * Блок данных `COPY ... FROM stdin;` читается целиком до строки `\.`.
 *
 * @param {AsyncIterable<string|Uint8Array>|Iterable<string|Uint8Array>} source
 */
export async function* statements(source) {
  const decoder = new TextDecoder();
  let buffer = ""; // необработанный хвост, начинается с начала текущего оператора
  let cursor = 0; // позиция лексера в буфере
  let tokens = [];
  let copy = false; // внутри блока данных COPY, ждём терминатор `\.`

  /** Разбирает буфер до места, где оператор или токен может продолжиться в следующем чанке. */
  function* drain(final) {
    const lexer = new RegExp(TOKEN.source, "y");
    while (true) {
      if (copy) {
        const terminator = buffer.indexOf("\n\\.\n", Math.max(cursor - 1, 0));
        if (terminator === -1) {
          if (final) throw new Error("Unterminated COPY FROM stdin block");
          cursor = Math.max(cursor, buffer.length - 3);
          return;
        }
        copy = false;
        cursor = terminator + 4;
      } else {
        if (cursor >= buffer.length) return;
        lexer.lastIndex = cursor;
        const text = lexer.exec(buffer)[0];
        if (!final) {
          // конструкция могла быть разрезана границей чанка — ждём продолжения
          if (lexer.lastIndex === buffer.length) return;
          if (text === "'" || text === '"' || text === "$") {
            const prefix = tokens.at(-1); // E перед обрезанной E-строкой
            if (text === "'" && prefix?.end === cursor && /^[eE]$/.test(prefix.value)) {
              cursor = tokens.pop().start;
            }
            return;
          }
          if (text === "/" && buffer[lexer.lastIndex] === "*") return;
        }
        if (text.startsWith("/*") && !skipNested(buffer, lexer, text)) {
          if (!final) return;
          throw new Error("Unterminated block comment");
        }
        const type = classify(text);
        if (type) tokens.push({ type, value: type === "identifier" ? unquote(text) : text, start: cursor, end: lexer.lastIndex });
        cursor = lexer.lastIndex;
        if (text !== ";") continue;
        if (upper(tokens[0]) === "COPY" && tokens.some((token) => upper(token) === "STDIN")) {
          copy = true;
          continue;
        }
      }
      yield { text: buffer.slice(0, cursor), tokens };
      buffer = buffer.slice(cursor);
      cursor = 0;
      tokens = [];
    }
  }

  for await (const chunk of source) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    yield* drain(false);
  }
  buffer += decoder.decode();
  yield* drain(true);
  if (buffer.trim()) yield { text: buffer, tokens }; // хвост без `;` — обычно финальные комментарии
}

/** Нефайловый вариант: весь дамп одной строкой, результат — массив операторов. */
export async function parse(sql) {
  const result = [];
  for await (const statement of statements([sql])) result.push(statement);
  return result;
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
 * Первый проход: пополняет карту уникальных ключей таблиц по одному оператору.
 * Нужен до раскладки записей, поскольку PRIMARY KEY обычно
 * объявляется в post-data — после самих данных таблицы.
 */
export function collect(tokens, tables) {
  const words = tokens.map(upper);
  const head = words.slice(0, 3).join(" ");
  if (/^CREATE (UNLOGGED )?TABLE/.test(head)) collectCreateTable(tokens, words, tables);
  else if (/^ALTER TABLE/.test(head)) collectAlterTable(tokens, words, tables);
  else if (head === "CREATE UNIQUE INDEX") collectUniqueIndex(tokens, words, tables);
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

/**
 * Путь и содержимое файла с хешем содержимого в имени: идентичные дубликаты
 * получают числовой суффикс, свободный номер находится перебором.
 */
async function placeContents(directory, contents, exists) {
  const hash = new Bun.CryptoHasher("sha256").update(contents).digest("hex");
  for (let duplicate = 1; ; duplicate++) {
    const path = `${directory}/${duplicate === 1 ? hash : `${hash}.${duplicate}`}.sql`;
    if (!(await exists(path))) return [path, contents];
  }
}

/**
 * Путь и содержимое файла записи. Записи с уникальным ключом идентифицируются
 * хешем ключа, дубликат — ошибка. Остальные — хешем содержимого.
 */
async function placeRow(row, tables, exists) {
  const contents = formatInsert(row);
  const directory = `data/rows/${component(row.name.schema)}/${component(row.name.table)}`;
  const key = selectKey(tables.get(row.name.key));
  if (key?.every((column) => row.columns.includes(column))) {
    const path = `${directory}/${keyHash(key.map((column) => row.values[row.columns.indexOf(column)]))}.sql`;
    if (await exists(path)) throw new Error(`Duplicate unique key or hash collision: ${path}`);
    return [path, contents];
  }
  return placeContents(directory, contents, exists);
}

// --- Разделение дампа ---------------------------------------------------------

/** Фаза восстановления, которую открывает оператор, либо null. */
function phaseOf(words) {
  const postData = ["INDEX", "UNIQUE", "TRIGGER", "RULE", "POLICY"];
  const constraint = ["CONSTRAINT", "FOREIGN", "VALIDATE"];
  if (words[0] === "CREATE" && postData.includes(words[1])) return "end";
  if (words[0] === "ALTER" && words[1] === "TABLE" && constraint.some((word) => words.includes(word))) return "end";
  if (words[0] === "INSERT" || words[0] === "COPY") return "data";
  if (words[0] === "SELECT" && words.includes("SETVAL")) return "data";
  return null;
}

/**
 * Второй проход: раскладывает поток операторов по файлам снимка.
 *
 * Дерево: begin.sql (pre-data) → data/ (записи и чанки) → end.sql (post-data);
 * порядок задаётся лексикографической сортировкой путей при join.
 * Каждый INSERT попадает в отдельный файл записи в data/rows/, прочие
 * data-операторы (setval, COPY) — в чанки с хешем содержимого в data/sql/;
 * операторы data-сегмента взаимно независимы, поэтому их порядок не важен.
 * Комментарии в data-сегменте отбрасываются; в pre-/post-data сохраняются.
 *
 * @param {AsyncIterable<{text: string, tokens: object[]}>|Iterable} source поток операторов
 * @param {Map} tables уникальные ключи таблиц, собранные первым проходом
 * @param {(path: string) => Promise<boolean>} exists занят ли путь (для дубликатов)
 * @yields {[string, string]} относительный путь → содержимое файла
 */
export async function* splitFiles(source, tables, exists = async () => false) {
  const begin = [];
  const end = [];
  let phase = "begin";
  let transaction = null;

  for await (const { text, tokens } of source) {
    const words = tokens.map(upper);
    if (transaction) {
      transaction.push(text);
      if (words[0] === "COMMIT" && words[1] !== "PREPARED") {
        const contents = transaction.join("");
        yield await placeContents("data/sql", contents.endsWith("\n") ? contents : `${contents}\n`, exists);
        transaction = null;
      }
      continue;
    }
    if (words[0] === "COMMIT" && words[1] !== "PREPARED") throw new Error("COMMIT without BEGIN");
    if (words[0] === "BEGIN") {
      if (phase === "begin") {
        if (begin.length) yield ["begin.sql", `${begin.join("\n\n")}\n`];
        begin.length = 0;
        phase = "data";
      }
      transaction = [text.slice(tokens[0].start)];
      continue;
    }

    const next = phaseOf(words);
    if (next && phase === "begin" && begin.length) {
      yield ["begin.sql", `${begin.join("\n\n")}\n`];
      begin.length = 0;
    }
    if (next) phase = next;

    if (words[0] === "INSERT") {
      const row = parseInsert(text, tokens);
      yield await placeRow(row, tables, exists);
    } else if (phase === "data") {
      const statement = tokens.length ? text.slice(tokens[0].start).trim() : "";
      if (statement) yield await placeContents("data/sql", `${statement}\n`, exists);
    } else if (text.trim()) {
      (phase === "begin" ? begin : end).push(text.trim());
    }
  }

  if (transaction) throw new Error("BEGIN without COMMIT");
  if (begin.length) yield ["begin.sql", `${begin.join("\n\n")}\n`];
  if (end.length) yield ["end.sql", `${end.join("\n\n")}\n`];
}

/** Делит дамп-строку на Map путь → содержимое (для тестов и мелких дампов). */
export async function splitDump(sql) {
  const parsed = await parse(sql);
  const tables = new Map();
  for (const { tokens } of parsed) collect(tokens, tables);
  const files = new Map();
  for await (const [path, contents] of splitFiles(parsed, tables, async (path) => files.has(path))) {
    files.set(path, contents);
  }
  return files;
}
