import 'dotenv/config';
import { PrismaClient, Priority, TaskScope, UserRole } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const family = await prisma.family.upsert({
    where: {
      id: 'seed-family',
    },
    update: {},
    create: {
      id: 'seed-family',
      name: 'Familia Demo',
      settings: {
        create: {
          timezone: 'America/Santiago',
          dailyBriefingTime: '08:30',
          reminderMinutesBefore: 30,
        },
      },
    },
    include: {
      settings: true,
    },
  });

  const admin = await prisma.user.upsert({
    where: {
      phoneNumber: '+56911111111',
    },
    update: {},
    create: {
      familyId: family.id,
      name: 'Felipe',
      phoneNumber: '+56911111111',
      role: UserRole.FAMILY_ADMIN,
      timezone: 'America/Santiago',
      dailyBriefingTime: '08:30',
    },
  });

  const member = await prisma.user.upsert({
    where: {
      phoneNumber: '+56922222222',
    },
    update: {},
    create: {
      familyId: family.id,
      name: 'Camila',
      phoneNumber: '+56922222222',
      role: UserRole.USER,
      timezone: 'America/Santiago',
      dailyBriefingTime: '08:30',
    },
  });

  const existingTask = await prisma.task.findFirst({
    where: { title: 'Preparar workshop' },
  });

  if (!existingTask) {
    await prisma.task.createMany({
      data: [
        {
          familyId: family.id,
          createdByUserId: admin.id,
          assignedToUserId: admin.id,
          title: 'Preparar workshop',
          priority: Priority.MEDIUM,
          scope: TaskScope.PERSONAL,
        },
        {
          familyId: family.id,
          createdByUserId: admin.id,
          assignedToUserId: member.id,
          title: 'Comprar pan',
          priority: Priority.LOW,
          scope: TaskScope.FAMILY,
        },
      ],
    });
  }
}

main()
  .catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
