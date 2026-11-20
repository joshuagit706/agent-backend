import { IsArray, IsString, IsOptional, IsInt, IsBoolean, Min, Max } from 'class-validator';

export class CreateExecutionBatchDto {
  @IsArray()
  @IsString({ each: true })
  issueIds: string[];

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  concurrencyLimit?: number;

  @IsOptional()
  @IsString()
  branchPrefix?: string;

  @IsOptional()
  @IsBoolean()
  requirePlanApproval?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  retryLimit?: number;
}

export class ApprovePlanDto {
  @IsString()
  executionJobId: string;

  @IsBoolean()
  approved: boolean;
}
