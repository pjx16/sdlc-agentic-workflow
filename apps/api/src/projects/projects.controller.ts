import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import type { ProjectDto } from './project.dto';
import { ProjectsService } from './projects.service';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(): Promise<ProjectDto[]> {
    return this.projects.list();
  }

  @Post()
  create(@Body() body: unknown): Promise<ProjectDto> {
    return this.projects.create(body);
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<ProjectDto> {
    return this.projects.get(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown): Promise<ProjectDto> {
    return this.projects.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  disable(@Param('id') id: string): Promise<ProjectDto> {
    return this.projects.disable(id);
  }

  @Post(':id/mirror/retry')
  @HttpCode(HttpStatus.OK)
  retryMirror(@Param('id') id: string): Promise<ProjectDto> {
    return this.projects.retryMirror(id);
  }
}
