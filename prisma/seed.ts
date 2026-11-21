import 'dotenv/config';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, UserStatus } from '../src/generated/prisma/client.js';

const TEST_USER = {
  email: 'ikamaev@vks.test',
  name: 'ikamaev',
  password: 'ikamaev-test',
};

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('Не задано значение DATABASE_URL');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});

try {
  const passwordHash = await argon2.hash(TEST_USER.password, {
    type: argon2.argon2id,
  });

  const user = await prisma.user.upsert({
    where: { email: TEST_USER.email },
    update: {
      name: TEST_USER.name,
      passwordHash,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
    },
    create: {
      email: TEST_USER.email,
      name: TEST_USER.name,
      passwordHash,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
    },
  });

  console.log(`Тестовый пользователь готов: ${user.email} (id=${user.id})`);
} finally {
  await prisma.$disconnect();
}
