import { Body, Controller, Get, OnModuleInit, Param, Put } from '@nestjs/common';
import { GuidelinesService, type TreeNode, wildcardToPath } from './guidelines.service';

@Controller('guidelines')
export class GuidelinesController implements OnModuleInit {
  constructor(private readonly guidelines: GuidelinesService) {}

  async onModuleInit(): Promise<void> {
    await this.guidelines.onInit();
  }

  @Get()
  tree(): Promise<TreeNode[]> {
    return this.guidelines.tree();
  }

  @Get('*path')
  read(@Param('path') path: string | string[]) {
    return this.guidelines.read(wildcardToPath(path));
  }

  @Put('*path')
  write(@Param('path') path: string | string[], @Body() body: { content?: unknown }) {
    return this.guidelines.write(wildcardToPath(path), body?.content);
  }
}
