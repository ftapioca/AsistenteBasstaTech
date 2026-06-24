import { Module } from '@nestjs/common';
import { FamiliesModule } from '../families/families.module';
import { UsersService } from './users.service';

@Module({
  imports: [FamiliesModule],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
