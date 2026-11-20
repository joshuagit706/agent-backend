import { Controller, Get, Patch, Post, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { UsersService, UpdateSettingsDto } from './users.service.js';

export class SetApiKeyDto {
  @IsString() apiKey!: string;
}

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('settings')
  getSettings(@CurrentUser('id') userId: string) {
    return this.usersService.getSettings(userId);
  }

  @Patch('settings')
  updateSettings(@CurrentUser('id') userId: string, @Body() dto: UpdateSettingsDto) {
    return this.usersService.updateSettings(userId, dto);
  }

  @Get('stats')
  getStats(@CurrentUser('id') userId: string) {
    return this.usersService.getStats(userId);
  }

  @Get('usage')
  getUsage(@CurrentUser('id') userId: string) {
    return this.usersService.getUsageSummary(userId);
  }

  @Get('api-keys')
  getApiKeys(@CurrentUser('id') userId: string) {
    return this.usersService.getApiKeyStatus(userId);
  }

  @Post('api-keys/:provider')
  setApiKey(
    @CurrentUser('id') userId: string,
    @Param('provider') provider: string,
    @Body() dto: SetApiKeyDto,
  ) {
    return this.usersService.setApiKey(userId, provider, dto.apiKey).then(() => ({ ok: true }));
  }

  @Delete('api-keys/:provider')
  removeApiKey(@CurrentUser('id') userId: string, @Param('provider') provider: string) {
    return this.usersService.removeApiKey(userId, provider).then(() => ({ ok: true }));
  }
}
