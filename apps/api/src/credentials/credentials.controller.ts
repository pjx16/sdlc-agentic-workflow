import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { CredentialValueBodySchema, ErrorCodes, credentialDefinition, type CredentialKey, type CredentialView } from '@sdlc/shared';
import { ApiException } from '../common/api-exception';
import { parseBody } from '../common/parse-body';
import { CredentialTester, type TestResult } from './credential-tester';
import { CredentialsService } from './credentials.service';

function keyOf(raw: string): CredentialKey {
  const def = credentialDefinition(raw);
  if (!def) throw new ApiException(HttpStatus.NOT_FOUND, ErrorCodes.notFound, 'Unknown credential');
  return def.key;
}

/** Authenticated (the session middleware covers every non-public route). Values in request bodies are never logged. */
@Controller('credentials')
export class CredentialsController {
  constructor(
    private readonly creds: CredentialsService,
    private readonly tester: CredentialTester,
  ) {}

  @Get()
  list(): Promise<CredentialView[]> {
    return this.creds.views();
  }

  @Put(':key')
  async put(@Param('key') raw: string, @Body() body: unknown): Promise<CredentialView> {
    const key = keyOf(raw);
    const { value } = parseBody(CredentialValueBodySchema, body ?? {}, 'Invalid request');
    await this.creds.set(key, value);
    return (await this.creds.views()).find((v) => v.key === key) as CredentialView;
  }

  @Delete(':key')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('key') raw: string): Promise<void> {
    await this.creds.remove(keyOf(raw));
  }

  @Post(':key/test')
  @HttpCode(HttpStatus.OK)
  test(@Param('key') raw: string): Promise<TestResult> {
    return this.tester.test(keyOf(raw));
  }
}

