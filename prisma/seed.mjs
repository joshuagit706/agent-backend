import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const deepseek = await prisma.aIProvider.upsert({
    where: { name: 'deepseek' },
    update: {},
    create: { name: 'deepseek', displayName: 'DeepSeek', baseUrl: 'https://api.deepseek.com', isActive: true },
  });

  for (const model of [
    { modelId: 'deepseek-chat', displayName: 'DeepSeek Chat', inputCostPer1k: 0.00014, outputCostPer1k: 0.00028 },
    { modelId: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner', inputCostPer1k: 0.00055, outputCostPer1k: 0.00219 },
  ]) {
    await prisma.aIModel.upsert({
      where: { providerId_modelId: { providerId: deepseek.id, modelId: model.modelId } },
      update: {},
      create: { providerId: deepseek.id, ...model, contextWindow: 128000, supportsTools: true, isActive: true },
    });
  }

  const anthropic = await prisma.aIProvider.upsert({
    where: { name: 'anthropic' },
    update: {},
    create: { name: 'anthropic', displayName: 'Anthropic', baseUrl: 'https://api.anthropic.com', isActive: false },
  });

  await prisma.aIModel.upsert({
    where: { providerId_modelId: { providerId: anthropic.id, modelId: 'claude-3-5-sonnet-20241022' } },
    update: {},
    create: { providerId: anthropic.id, modelId: 'claude-3-5-sonnet-20241022', displayName: 'Claude 3.5 Sonnet', contextWindow: 200000, inputCostPer1k: 0.003, outputCostPer1k: 0.015, supportsTools: true, isActive: false },
  });

  console.log('Seeded AI providers and models');
}

main().catch(console.error).finally(() => prisma.$disconnect());
