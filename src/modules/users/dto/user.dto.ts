import { ApiProperty } from '@nestjs/swagger';
import {
  User,
  UserRole,
  UserStatus,
} from '../../../generated/prisma/client.js';

export class UserDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'user@example.com' })
  email: string;

  @ApiProperty({ example: 'Иван Иванов' })
  name: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '/uploads/avatars/1.png',
  })
  avatarUrl: string | null;

  @ApiProperty({ enum: UserRole, enumName: 'UserRole' })
  role: UserRole;

  @ApiProperty({ enum: UserStatus, enumName: 'UserStatus' })
  status: UserStatus;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  emailVerifiedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static fromEntity(user: User): UserDto {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: user.role,
      status: user.status,
      emailVerifiedAt: user.emailVerifiedAt,
      createdAt: user.createdAt,
    };
  }
}
