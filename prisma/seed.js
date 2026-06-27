import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // 1. Create Default Admin User
  const adminEmail = 'admin@play.vawam.ca';
  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
  
  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash('password123', 10);
    const admin = await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash,
        role: 'ADMIN'
      }
    });
    console.log(`Created Admin User: ${admin.email} (Password: password123)`);
  } else {
    console.log('Admin user already exists.');
  }

  // 2. Create Default Categories
  const categories = [
    { name: 'Heavy Rotation', description: 'Currently trending hits' },
    { name: 'Classic Rock', description: '70s and 80s Rock classics' },
    { name: 'Jingles', description: 'Short station sweepers' },
    { name: 'Commercials', description: 'Advertiser play blocks' },
    { name: 'Talk Programs', description: 'Podcasts and voice tracks' }
  ];

  for (const cat of categories) {
    const existingCat = await prisma.trackCategory.findUnique({ where: { name: cat.name } });
    if (!existingCat) {
      await prisma.trackCategory.create({ data: cat });
      console.log(`Created Category: ${cat.name}`);
    }
  }

  // 3. Create Default System Settings
  const defaultTheme = {
    primary: '#00f0ff',
    secondary: '#7000ff',
    logoUrl: '/images/default-logo.png'
  };

  const defaultStationInfo = {
    name: 'RadioPlay One',
    tagline: 'The Ultimate Web Automation System'
  };

  await prisma.systemSetting.upsert({
    where: { key: 'theme' },
    update: {},
    create: { key: 'theme', value: JSON.stringify(defaultTheme) }
  });

  await prisma.systemSetting.upsert({
    where: { key: 'station_info' },
    update: {},
    create: { key: 'station_info', value: JSON.stringify(defaultStationInfo) }
  });

  console.log('System settings seeded.');
  console.log('Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error('Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
