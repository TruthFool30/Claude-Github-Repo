import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { BookOpen, CalendarDays } from 'lucide-react';
import { useLive } from '../../lib/live';
import { PageHeader, PageSpinner, Tabs } from '../../ui';
import mod from './index';
import { Planner } from './Planner';
import { RecipeBox } from './RecipeBox';
import { RecipeDetail } from './RecipeDetail';

const CookMode = lazy(() => import('./CookMode'));

export default function MealsPage() {
  useLive('meals');
  return (
    <Routes>
      <Route index element={<Section tab="plan" />} />
      <Route path="recipes" element={<Section tab="recipes" />} />
      <Route path="recipes/:id" element={<RecipeDetail />} />
      <Route
        path="recipes/:id/cook"
        element={
          <Suspense fallback={<PageSpinner />}>
            <CookMode />
          </Suspense>
        }
      />
      <Route path="*" element={<Navigate to="/meals" replace />} />
    </Routes>
  );
}

function Section({ tab }: { tab: 'plan' | 'recipes' }) {
  const navigate = useNavigate();
  const { search } = useLocation();
  return (
    <div>
      <PageHeader
        title={mod.label}
        subtitle={tab === 'plan' ? 'Plan the week, then shop in one tap' : 'Your family recipe box'}
        icon={mod.icon}
        accent={mod.accent}
        documentTitle={tab === 'plan' ? 'Meal planner' : 'Recipes'}
      >
        <Tabs
          accent={mod.accent}
          value={tab}
          onChange={(t) => navigate(t === 'plan' ? `/meals${tab === 'plan' ? search : ''}` : '/meals/recipes')}
          tabs={[
            { id: 'plan', label: 'Meal plan', icon: CalendarDays },
            { id: 'recipes', label: 'Recipes', icon: BookOpen },
          ]}
        />
      </PageHeader>
      {tab === 'plan' ? <Planner /> : <RecipeBox />}
    </div>
  );
}
