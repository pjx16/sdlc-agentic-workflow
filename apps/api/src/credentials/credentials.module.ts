import { Global, Module } from '@nestjs/common';
import { CredentialTester, TESTER_OPTIONS } from './credential-tester';
import { CredentialsController } from './credentials.controller';
import { CredentialsService } from './credentials.service';

/** Global so the API and the worker can both inject CredentialsService. The controller is served by the API only (the worker has no HTTP surface). */
@Global()
@Module({
  controllers: [CredentialsController],
  providers: [
    CredentialsService,
    // GITHUB_API_URL exists for the end-to-end tests, which point it at a local fake GitHub.
    { provide: TESTER_OPTIONS, useFactory: () => ({ githubApiUrl: process.env.GITHUB_API_URL || undefined }) },
    { provide: CredentialTester, useFactory: (creds: CredentialsService, options: object) => new CredentialTester(creds, options), inject: [CredentialsService, TESTER_OPTIONS] },
  ],
  exports: [CredentialsService, CredentialTester],
})
export class CredentialsModule {}
