import '@fastify/multipart';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';

const AVATAR_MAX_MB = 2;

export const AVATAR_MAX_BYTES = AVATAR_MAX_MB * 1024 * 1024;

const AVATARS_DIR = path.resolve(process.cwd(), 'uploads', 'avatars');
const PUBLIC_PREFIX = '/uploads/avatars';

type ImageExtension = 'jpg' | 'png' | 'webp' | 'gif';

export async function readAvatar(request: FastifyRequest): Promise<Buffer> {
  let file;

  try {
    file = await request.file();
  } catch (error) {
    if (hasCode(error, 'FST_REQ_FILE_TOO_LARGE')) {
      throw new PayloadTooLargeException(
        `Файл аватара больше ${AVATAR_MAX_MB} МБ`,
      );
    }

    if (
      hasCode(error, 'FST_INVALID_MULTIPART_CONTENT_TYPE') ||
      hasCode(error, 'FST_FILES_LIMIT')
    ) {
      throw new BadRequestException('Ожидается один файл аватара');
    }

    throw error;
  }

  if (!file || file.fieldname !== 'avatar') {
    throw new BadRequestException('Файл аватара не передан');
  }

  let buffer: Buffer;

  try {
    buffer = await file.toBuffer();
  } catch (error) {
    if (hasCode(error, 'FST_REQ_FILE_TOO_LARGE')) {
      throw new PayloadTooLargeException(
        `Файл аватара больше ${AVATAR_MAX_MB} МБ`,
      );
    }

    throw error;
  }

  if (!imageExtension(buffer)) {
    throw new BadRequestException(
      'Допустимы только изображения JPEG, PNG, WEBP и GIF',
    );
  }

  return buffer;
}

export async function storeAvatar(
  userId: number,
  file: Buffer,
): Promise<string> {
  const extension = imageExtension(file);

  if (!extension) {
    throw new BadRequestException(
      'Допустимы только изображения JPEG, PNG, WEBP и GIF',
    );
  }

  await mkdir(AVATARS_DIR, { recursive: true });

  const filename = `${userId}-${randomUUID()}.${extension}`;
  await writeFile(path.join(AVATARS_DIR, filename), file);

  return `${PUBLIC_PREFIX}/${filename}`;
}

export async function deleteStoredAvatar(
  avatarUrl: string | null,
): Promise<void> {
  if (!avatarUrl?.startsWith(`${PUBLIC_PREFIX}/`)) {
    return;
  }

  const filePath = path.resolve(AVATARS_DIR, path.basename(avatarUrl));

  if (!filePath.startsWith(`${AVATARS_DIR}${path.sep}`)) {
    return;
  }

  try {
    await unlink(filePath);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      throw error;
    }
  }
}

function imageExtension(file: Buffer): ImageExtension | null {
  if (
    file.length >= 3 &&
    file[0] === 0xff &&
    file[1] === 0xd8 &&
    file[2] === 0xff
  ) {
    return 'jpg';
  }

  if (
    file.length >= 8 &&
    file[0] === 0x89 &&
    file[1] === 0x50 &&
    file[2] === 0x4e &&
    file[3] === 0x47
  ) {
    return 'png';
  }

  if (file.length >= 12 && file.subarray(0, 4).toString('ascii') === 'RIFF') {
    if (file.subarray(8, 12).toString('ascii') === 'WEBP') {
      return 'webp';
    }
  }

  if (file.length >= 6) {
    const signature = file.subarray(0, 6).toString('ascii');

    if (signature === 'GIF87a' || signature === 'GIF89a') {
      return 'gif';
    }
  }

  return null;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
