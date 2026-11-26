import { ApiProperty } from '@nestjs/swagger';
import { RoomMember, User } from '../../../generated/prisma/client.js';
import { PaginatedDto } from '../../../common/dto/paginated.dto.js';

export class RoomMemberUserDto {
  @ApiProperty({ example: 2 })
  id: number;

  @ApiProperty({ example: 'Мария Смирнова' })
  name: string;

  @ApiProperty({ example: 'maria@example.com' })
  email: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '/uploads/avatars/2.png',
  })
  avatarUrl: string | null;
}

/** Пользователь из списка допуска. Владельца комнаты в этом списке нет. */
export class RoomMemberDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: RoomMemberUserDto })
  user: RoomMemberUserDto;

  @ApiProperty({ example: 1, description: 'Кто добавил пользователя' })
  addedById: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static fromEntity(
    member: RoomMember & {
      user: Pick<User, 'id' | 'name' | 'email' | 'avatarUrl'>;
    },
  ): RoomMemberDto {
    return {
      id: member.id,
      user: {
        id: member.user.id,
        name: member.user.name,
        email: member.user.email,
        avatarUrl: member.user.avatarUrl,
      },
      addedById: member.addedById,
      createdAt: member.createdAt,
    };
  }
}

export class RoomMemberListDto extends PaginatedDto {
  @ApiProperty({ type: [RoomMemberDto] })
  items: RoomMemberDto[];
}
