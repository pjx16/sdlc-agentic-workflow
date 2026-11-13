import { redirect } from 'next/navigation';

/** The old Support page is now the Inbox. */
export default function SupportPage(): never {
  redirect('/inbox');
}
