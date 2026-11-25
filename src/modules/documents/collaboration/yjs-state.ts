import * as Y from 'yjs';

/** Пустое, но валидное состояние: `Y.applyUpdate` не принимает пустой байтовый массив. */
export function emptyYjsState(): Uint8Array<ArrayBuffer> {
  const document = new Y.Doc();
  const state = toBytes(Y.encodeStateAsUpdate(document));

  document.destroy();

  return state;
}

/** Копия в обычный ArrayBuffer: Prisma не принимает SharedArrayBuffer. */
export function toBytes(state: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(state.byteLength);

  bytes.set(state);

  return bytes;
}

/**
 * Содержимое общих типов Yjs без метаданных клиента.
 * Синхронизация пустого документа и Awareness это значение не меняют.
 *
 * Удалённое обновление создаёт корневой тип через `doc.get(name)` без конструктора,
 * поэтому на сервере это `AbstractType`, у которого `toJSON()` пустой.
 * Текст и вложенные узлы читаются из уже интегрированного списка элементов.
 */
export function visibleState(document: Y.Doc): string {
  const parts: string[] = [];

  document.share.forEach((type, key) => {
    parts.push(`${key}:${JSON.stringify(readType(type))}`);
  });
  parts.sort();

  return parts.join('\n');
}

function readType(type: ReadableType): unknown {
  const rendered = type.toJSON();

  if (rendered !== undefined) {
    return rendered;
  }

  return readIntegrated(type);
}

interface ReadableType {
  toJSON: () => unknown;
}

interface IntegratedItem {
  deleted: boolean;
  right: IntegratedItem | null;
  content: ItemContent;
}

interface ItemContent {
  str?: string;
  key?: string;
  value?: unknown;
  embed?: unknown;
  type?: ReadableType;
  getContent?: () => unknown[];
}

function readIntegrated(type: object): unknown {
  const node = type as {
    _start: IntegratedItem | null;
    _map?: Map<string, IntegratedItem | null>;
  };
  const list: unknown[] = [];

  for (let item = node._start; item !== null; item = item.right) {
    if (!item.deleted) {
      list.push(readContent(item.content));
    }
  }

  const fields: Record<string, unknown> = {};

  node._map?.forEach((item, key) => {
    const values: unknown[] = [];

    for (let current = item; current !== null; current = current.right) {
      if (!current.deleted) {
        values.push(readContent(current.content));
      }
    }

    if (values.length === 1) {
      fields[key] = values[0];
    } else if (values.length > 1) {
      fields[key] = values;
    }
  });

  if (Object.keys(fields).length === 0) {
    return list;
  }

  if (list.length === 0) {
    return fields;
  }

  return { list, fields };
}

function readContent(content: ItemContent): unknown {
  if (typeof content.str === 'string') {
    return content.str;
  }

  if (typeof content.key === 'string') {
    return { format: content.key, value: content.value ?? null };
  }

  if (content.embed !== undefined) {
    return { embed: content.embed };
  }

  if (content.type) {
    return readType(content.type);
  }

  if (content.getContent) {
    return content
      .getContent()
      .map((value) => (isIntegratedType(value) ? readType(value) : value));
  }

  return null;
}

function isIntegratedType(value: unknown): value is ReadableType {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_start' in value &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  );
}
