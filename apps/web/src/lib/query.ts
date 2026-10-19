import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
});

export const qk = {
  projects: (search: string, sort: string) => ['projects', search, sort] as const,
  allProjects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  media: (projectId?: string) => ['media', projectId ?? 'all'] as const,
  renders: (projectId: string) => ['renders', projectId] as const,
  integrations: ['integrations'] as const,
  usage: ['usage'] as const,
  me: ['me'] as const,
  voices: ['voices'] as const,
  social: ['social'] as const,
  publications: (projectId: string) => ['publications', projectId] as const,
};
