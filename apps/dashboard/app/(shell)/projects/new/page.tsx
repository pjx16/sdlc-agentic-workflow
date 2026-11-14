import Link from 'next/link';
import { OnboardForm } from '@/components/onboard-form';
import { ProjectForm } from '@/components/project-form';

export default async function NewProjectPage({ searchParams }: { searchParams: Promise<{ manual?: string }> }) {
  const { manual } = await searchParams;
  return (
    <section>
      <h1 className="mb-2 text-2xl font-semibold">New project</h1>
      {manual === '1' ? (
        <>
          <p className="mb-6 text-sm text-muted">
            Every setting by hand. <Link href="/projects/new" className="text-accent hover:underline">Start with the repository instead</Link>
          </p>
          <ProjectForm />
        </>
      ) : (
        <>
          <p className="mb-6 text-sm text-muted">Give the repository and, if you use Jira, the project key. The rest is proposed for you to review.</p>
          <OnboardForm />
          <p className="mt-8 text-sm text-muted">
            Prefer to fill in every setting yourself? <Link href="/projects/new?manual=1" className="text-accent hover:underline">Create it manually</Link>
          </p>
        </>
      )}
    </section>
  );
}
