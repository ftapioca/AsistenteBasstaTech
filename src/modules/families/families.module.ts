import { Module } from '@nestjs/common';
import { FamiliesService } from './families.service';

@Module({
  providers: [FamiliesService],
  exports: [FamiliesService],
})
export class FamiliesModule {}
