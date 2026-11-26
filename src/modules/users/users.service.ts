import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, User, UserStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { deleteStoredAvatar, storeAvatar } from './avatar-file.js';
import { UserSearchQueryDto } from './dto/user-search-query.dto.js';
import { UserDto, UserListDto } from './dto/user.dto.js';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async search(query: UserSearchQueryDto): Promise<UserListDto> {
    const where: Prisma.UserWhereInput = {
      status: UserStatus.ACTIVE,
      OR: [
        { name: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ],
    };
    const [total, users] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.limit,
      }),
    ]);

    return {
      items: users.map((user) => UserDto.fromEntity(user)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  create(data: {
    email: string;
    passwordHash: string;
    name: string;
    emailVerifiedAt: Date | null;
  }): Promise<User> {
    return this.prisma.user.create({ data });
  }

  async getById(id: number): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });

    if (!user) {
      throw new NotFoundException('Пользователь не найден');
    }

    return user;
  }

  async update(id: number, data: { name?: string }): Promise<User> {
    const changes: { name?: string } = {};

    if (data.name !== undefined) {
      changes.name = data.name;
    }

    if (Object.keys(changes).length === 0) {
      throw new BadRequestException('Не указаны поля для обновления');
    }

    await this.getById(id);

    return this.prisma.user.update({
      where: { id },
      data: changes,
    });
  }

  async updateAvatar(id: number, file: Buffer): Promise<User> {
    const user = await this.getById(id);
    const avatarUrl = await storeAvatar(user.id, file);

    try {
      const updated = await this.prisma.user.update({
        where: { id },
        data: { avatarUrl },
      });
      await deleteStoredAvatar(user.avatarUrl);
      return updated;
    } catch (error) {
      await deleteStoredAvatar(avatarUrl);
      throw error;
    }
  }
}
