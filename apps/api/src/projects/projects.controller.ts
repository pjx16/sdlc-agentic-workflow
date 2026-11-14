import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import type { ProjectDto } from './project.dto';
import { OnboardingService } from './onboarding.service';
import { ProjectsService } from './projects.service';

@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly onboarding: OnboardingService,
  ) {}

  @Get()
  list(): Promise<ProjectDto[]> {
    return this.projects.list();
  }

  /** The two-field start: a repo URL and, optionally, a Jira project key (BUILD_PLAN v1 6.7). */
  @Post('onboard')
  start(@Body() body: unknown): Promise<ProjectDto> {
    return this.onboarding.start(body);
  }

  @Get(':id/onboarding')
  onboardingOf(@Param('id') id: string) {
    return this.onboarding.get(id);
  }

  @Post(':id/onboarding/rerun')
  @HttpCode(HttpStatus.OK)
  rerunOnboarding(@Param('id') id: string) {
    return this.onboarding.rerun(id);
  }

  @Patch(':id/onboarding/sections/:section')
  section(@Param('id') id: string, @Param('section') section: string, @Body() body: unknown) {
    return this.onboarding.section(id, section, body);
  }

  @Post(':id/onboarding/dry-run')
  @HttpCode(HttpStatus.OK)
  dryRun(@Param('id') id: string) {
    return this.onboarding.dryRun(id);
  }

  @Post(':id/onboarding/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(@Param('id') id: string) {
    return this.onboarding.confirm(id);
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

  @Get(':id/delete-impact')
  deleteImpact(@Param('id') id: string) {
    return this.projects.deleteImpact(id);
  }

  /** Permanent delete (DELETE /projects/:id above only disables). */
  @Delete(':id/permanent')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string) {
    return this.projects.remove(id);
  }

  @Get(':id/jira/statuses')
  jiraStatuses(@Param('id') id: string): Promise<string[]> {
    return this.projects.jiraStatuses(id);
  }

  @Post(':id/mirror/retry')
  @HttpCode(HttpStatus.OK)
  retryMirror(@Param('id') id: string): Promise<ProjectDto> {
    return this.projects.retryMirror(id);
  }
}
