import { type EgressFixture, startEgress } from './docker-fixture';

/** For `LIVE_CLAUDE=1 npm run test:live`: starts the real proxy and agent network. Does nothing without LIVE_CLAUDE. */
export default async function setup(): Promise<() => Promise<void>> {
  if (!process.env.LIVE_CLAUDE) return async () => undefined;
  const egress: EgressFixture = await startEgress();
  return () => egress.stop();
}
