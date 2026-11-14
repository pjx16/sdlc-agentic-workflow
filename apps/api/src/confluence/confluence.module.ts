import { Global, Module } from '@nestjs/common';
import { ConfluenceClients } from './confluence-clients';

/** The Confluence client, available to the API and the worker. */
@Global()
@Module({ providers: [ConfluenceClients], exports: [ConfluenceClients] })
export class ConfluenceModule {}
