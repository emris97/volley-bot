import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';

async function bootstrap() {
  const app = await NestFactory.create(WorkerModule);
  await app.listen(process.env.port ?? 3000);
}
void bootstrap();
