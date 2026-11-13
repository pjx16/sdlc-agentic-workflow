import { Global, Module } from '@nestjs/common';
import { SupportRaiser } from './support-raiser';
import { SupportTransitionListener } from './support-listener';

/** What raises and closes support tickets, with no controller: the state machine, the worker and the credential checks all use it. */
@Global()
@Module({ providers: [SupportRaiser, SupportTransitionListener], exports: [SupportRaiser, SupportTransitionListener] })
export class SupportCoreModule {}
