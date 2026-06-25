import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Settings, User, UserRole } from '@prisma/client';
import { DateTime } from 'luxon';
import { FamiliesService } from '../families/families.service';
import { PrismaService } from '../database/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';

type UserWithSettings = User & {
  family: {
    name: string;
    settings: Settings | null;
  };
};

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly familiesService: FamiliesService,
    private readonly configService: ConfigService,
  ) {}

  async findByTelegramUserId(telegramUserId: string) {
    return this.prisma.user.findUnique({
      where: { telegramUserId },
      include: {
        family: {
          include: {
            settings: true,
          },
        },
      },
    });
  }

  async findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      include: {
        family: {
          include: {
            settings: true,
          },
        },
      },
    });
  }

  async createFamilyAdmin(input: {
    familyName: string;
    name: string;
    phoneNumber: string;
    telegramUserId: string;
    telegramChatId: string;
    telegramUsername?: string | null;
  }) {
    const family = await this.familiesService.createFamily(input.familyName);

    return this.prisma.user.create({
      data: {
        familyId: family.id,
        name: input.name,
        phoneNumber: normalizePhoneNumber(input.phoneNumber),
        telegramUserId: input.telegramUserId,
        telegramChatId: input.telegramChatId,
        telegramUsername: input.telegramUsername ?? null,
        role: UserRole.FAMILY_ADMIN,
        timezone: family.settings?.timezone ?? this.defaultTimezone,
        dailyBriefingTime:
          family.settings?.dailyBriefingTime ?? this.defaultBriefingTime,
      },
      include: {
        family: {
          include: {
            settings: true,
          },
        },
      },
    });
  }

  async createManagedUser(adminUserId: string, dto: CreateUserDto) {
    const admin = await this.requireActiveUser(adminUserId);
    if (admin.role !== UserRole.FAMILY_ADMIN) {
      throw new BadRequestException(
        'Solo un administrador familiar puede crear usuarios.',
      );
    }

    const phoneNumber = normalizePhoneNumber(dto.phoneNumber);
    const existing = await this.prisma.user.findUnique({
      where: { phoneNumber },
    });

    if (existing && existing.familyId !== admin.familyId) {
      throw new BadRequestException(
        'Ese telefono ya pertenece a otra familia.',
      );
    }

    if (existing?.role === UserRole.FAMILY_ADMIN) {
      throw new BadRequestException(
        'Ese telefono pertenece al administrador familiar y no puede agregarse como miembro.',
      );
    }

    if (existing) {
      return this.prisma.user.update({
        where: { id: existing.id },
        data: {
          name: dto.name,
          isActive: true,
        },
      });
    }

    const resolvedTimezone = this.resolveTimezone(admin);
    const resolvedBriefingTime = this.resolveDailyBriefingTime(admin);

    return this.prisma.user.create({
      data: {
        familyId: admin.familyId,
        name: dto.name,
        phoneNumber,
        role: UserRole.USER,
        timezone: resolvedTimezone,
        dailyBriefingTime: resolvedBriefingTime,
      },
    });
  }

  async listManagedUsers(adminUserId: string) {
    const admin = await this.requireActiveUser(adminUserId);
    if (admin.role !== UserRole.FAMILY_ADMIN) {
      throw new BadRequestException(
        'Solo un administrador familiar puede gestionar usuarios.',
      );
    }

    return this.prisma.user.findMany({
      where: {
        familyId: admin.familyId,
        isActive: true,
        role: UserRole.USER,
      },
      orderBy: { name: 'asc' },
    });
  }

  async deactivateManagedUser(adminUserId: string, targetUserId: string) {
    const admin = await this.requireActiveUser(adminUserId);
    if (admin.role !== UserRole.FAMILY_ADMIN) {
      throw new BadRequestException(
        'Solo un administrador familiar puede quitar usuarios.',
      );
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!target || target.familyId !== admin.familyId) {
      throw new NotFoundException('Usuario no encontrado en tu familia.');
    }

    if (target.role === UserRole.FAMILY_ADMIN) {
      throw new BadRequestException(
        'No puedes quitar al administrador principal de la familia.',
      );
    }

    return this.prisma.user.update({
      where: { id: target.id },
      data: {
        isActive: false,
        telegramUserId: null,
        telegramChatId: null,
        telegramUsername: null,
      },
    });
  }

  async linkTelegramAccount(input: {
    phoneNumber: string;
    telegramUserId: string;
    telegramChatId: string;
    telegramUsername?: string | null;
    fallbackName: string;
  }) {
    const phoneNumber = normalizePhoneNumber(input.phoneNumber);
    const existing = await this.prisma.user.findUnique({
      where: { phoneNumber },
      include: {
        family: {
          include: {
            settings: true,
          },
        },
      },
    });

    if (!existing) {
      return this.createFamilyAdmin({
        familyName: `Familia de ${input.fallbackName}`,
        name: input.fallbackName,
        phoneNumber,
        telegramUserId: input.telegramUserId,
        telegramChatId: input.telegramChatId,
        telegramUsername: input.telegramUsername,
      });
    }

    if (
      existing.telegramUserId &&
      existing.telegramUserId !== input.telegramUserId
    ) {
      throw new BadRequestException(
        'Ese usuario ya esta vinculado a otra cuenta de Telegram.',
      );
    }

    return this.prisma.user.update({
      where: { id: existing.id },
      data: {
        telegramUserId: input.telegramUserId,
        telegramChatId: input.telegramChatId,
        telegramUsername: input.telegramUsername ?? null,
        isActive: true,
      },
      include: {
        family: {
          include: {
            settings: true,
          },
        },
      },
    });
  }

  async requireActiveUser(userId: string) {
    const user = await this.findById(userId);
    if (!user || !user.isActive) {
      throw new NotFoundException('Usuario no encontrado o inactivo.');
    }
    return user;
  }

  async getUsersEligibleForBriefing() {
    return this.prisma.user.findMany({
      where: {
        isActive: true,
        telegramChatId: { not: null },
      },
      include: {
        family: {
          include: {
            settings: true,
          },
        },
      },
    });
  }

  resolveTimezone(user: UserWithSettings) {
    return (
      user.timezone || user.family.settings?.timezone || this.defaultTimezone
    );
  }

  resolveDailyBriefingTime(user: UserWithSettings) {
    return (
      user.dailyBriefingTime ||
      user.family.settings?.dailyBriefingTime ||
      this.defaultBriefingTime
    );
  }

  isBriefingDueNow(user: UserWithSettings, nowUtc = DateTime.utc()) {
    const timezone = this.resolveTimezone(user);
    const briefingTime = this.resolveDailyBriefingTime(user);
    const localNow = nowUtc.setZone(timezone);
    const [hour, minute] = briefingTime.split(':').map(Number);
    const graceMinutes = this.configService.get<number>(
      'DAILY_BRIEFING_GRACE_MINUTES',
      240,
    );
    const scheduledAt = localNow.set({
      hour,
      minute,
      second: 0,
      millisecond: 0,
    });

    return (
      localNow >= scheduledAt &&
      localNow < scheduledAt.plus({ minutes: graceMinutes })
    );
  }

  getLocalDate(user: UserWithSettings, nowUtc = DateTime.utc()) {
    return (
      nowUtc.setZone(this.resolveTimezone(user)).toISODate() ?? '1970-01-01'
    );
  }

  private get defaultTimezone() {
    return this.configService.get<string>(
      'DEFAULT_TIMEZONE',
      'America/Santiago',
    );
  }

  private get defaultBriefingTime() {
    return this.configService.get<string>(
      'DEFAULT_DAILY_BRIEFING_TIME',
      '08:30',
    );
  }
}

function normalizePhoneNumber(phoneNumber: string) {
  return phoneNumber.replace(/[^\d+]/g, '');
}
