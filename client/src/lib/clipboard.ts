import { toast } from '../ui/toast';

/** Copy text and confirm with a toast ("Invite code copied"), or explain when the browser refuses. */
export async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error('Could not copy — select and copy it manually');
  }
}
