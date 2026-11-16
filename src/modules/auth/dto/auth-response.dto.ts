import { ApiProperty } from '@nestjs/swagger';
import { UserDto } from '../../users/dto/user.dto.js';
import { ACCESS_TOKEN_TTL_SECONDS } from '../auth.constants.js';

export class AuthResponseDto {
  @ApiProperty({ description: 'JWT для заголовка Authorization: Bearer' })
  accessToken: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType: 'Bearer';

  @ApiProperty({
    example: ACCESS_TOKEN_TTL_SECONDS,
    description: 'Время жизни access token в секундах',
  })
  expiresIn: number;

  @ApiProperty({
    description:
      'Передаётся в заголовке X-CSRF-Token для /auth/refresh и /auth/logout. Дублируется в cookie csrf_token.',
  })
  csrfToken: string;

  @ApiProperty({ type: UserDto })
  user: UserDto;
}
