import { Global, Module } from '@nestjs/common';
import { StateMachine } from './state-machine.service';

@Global()
@Module({ providers: [StateMachine], exports: [StateMachine] })
export class StateModule {}
