import { Module } from '@nestjs/common';
import { JiraModule } from '../jira/jira.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({ imports: [JiraModule], controllers: [ProjectsController], providers: [ProjectsService] })
export class ProjectsModule {}
