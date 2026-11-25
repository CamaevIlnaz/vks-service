import { isUUID } from 'class-validator';

/** Постоянное имя Yjs-документа. Не зависит от конференции. */
export const DOCUMENT_NAME_PREFIX = 'document:';

export function documentName(documentId: string): string {
  return `${DOCUMENT_NAME_PREFIX}${documentId}`;
}

export function parseDocumentName(name: string): string | null {
  if (!name.startsWith(DOCUMENT_NAME_PREFIX)) {
    return null;
  }

  const documentId = name.slice(DOCUMENT_NAME_PREFIX.length);

  return isUUID(documentId) ? documentId : null;
}
