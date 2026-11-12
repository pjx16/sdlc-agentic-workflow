import { type MiddlewareConsumer, Module, RequestMethod, type NestModule } from '@nestjs/common';
import { CredentialsModule } from '../credentials/credentials.module';
import { AppConfig } from '../config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CLOCK } from './clock';
import { LoginLimiter } from './login-limiter';
import { SessionMiddleware } from './session.middleware';
import { SetupCodeService } from '../setup/setup-code.service';
import { SetupController } from '../setup/setup.controller';
import { SessionService } from './session.service';

@Module({
  imports: [CredentialsModule],
  controllers: [AuthController, SetupController],
  providers: [
    { provide: AppConfig, useFactory: () => new AppConfig() },
    { provide: CLOCK, useValue: () => Date.now() },
    AuthService,
    SessionService,
    LoginLimiter,
    SetupCodeService,
  ],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SessionMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
