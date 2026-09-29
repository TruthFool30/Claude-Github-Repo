// Placeholder page created by the foundation — the meals feature author replaces it.
import { Sparkles } from 'lucide-react';
import { EmptyState, PageHeader } from '../../ui';
import mod from './index';

export default function MealsPage() {
  return (
    <div>
      <PageHeader title={mod.label} subtitle={mod.description} icon={mod.icon} accent={mod.accent} />
      <EmptyState
        icon={mod.icon}
        accent={mod.accent}
        title="Coming soon"
        description={<>We're putting the finishing touches on {mod.label.toLowerCase()}. <Sparkles size={14} className="inline -mt-0.5" /></>}
      />
    </div>
  );
}
