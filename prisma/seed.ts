import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Seed AI providers
  const deepseek = await prisma.aIProvider.upsert({
    where: { name: 'deepseek' },
    update: {},
    create: {
      name: 'deepseek',
      displayName: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      isActive: true,
    },
  });

  await prisma.aIModel.upsert({
    where: { providerId_modelId: { providerId: deepseek.id, modelId: 'deepseek-chat' } },
    update: {},
    create: {
      providerId: deepseek.id,
      modelId: 'deepseek-chat',
      displayName: 'DeepSeek Chat',
      contextWindow: 128000,
      inputCostPer1k: 0.00014,
      outputCostPer1k: 0.00028,
      supportsTools: true,
      isActive: true,
    },
  });

  await prisma.aIModel.upsert({
    where: { providerId_modelId: { providerId: deepseek.id, modelId: 'deepseek-reasoner' } },
    update: {},
    create: {
      providerId: deepseek.id,
      modelId: 'deepseek-reasoner',
      displayName: 'DeepSeek Reasoner',
      contextWindow: 128000,
      inputCostPer1k: 0.00055,
      outputCostPer1k: 0.00219,
      supportsTools: false,
      isActive: true,
    },
  });

  // Anthropic
  const anthropic = await prisma.aIProvider.upsert({
    where: { name: 'anthropic' },
    update: {},
    create: {
      name: 'anthropic',
      displayName: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      isActive: false,
    },
  });

  await prisma.aIModel.upsert({
    where: { providerId_modelId: { providerId: anthropic.id, modelId: 'claude-3-5-sonnet-20241022' } },
    update: {},
    create: {
      providerId: anthropic.id,
      modelId: 'claude-3-5-sonnet-20241022',
      displayName: 'Claude 3.5 Sonnet',
      contextWindow: 200000,
      inputCostPer1k: 0.003,
      outputCostPer1k: 0.015,
      supportsTools: true,
      isActive: false,
    },
  });

  console.log('Database seeded successfully');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
