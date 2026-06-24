import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/)
  phoneNumber!: string;
}
