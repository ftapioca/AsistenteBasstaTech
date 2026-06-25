import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class FamiliesService {
  constructor(private readonly prisma: PrismaService) {}

  async createFamily(name: string) {
    return this.prisma.family.create({
      data: {
        name,
        settings: {
          create: {},
        },
      },
      include: {
        settings: true,
      },
    });
  }

  async renameFamily(familyId: string, name: string) {
    return this.prisma.family.update({
      where: { id: familyId },
      data: {
        name,
      },
      include: {
        settings: true,
      },
    });
  }
}
