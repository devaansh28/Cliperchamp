import { create } from 'zustand';
import { auth, type AuthSession } from '@/lib/auth';

interface AuthState {
  status: 'loading' | 'signed-in' | 'signed-out';
  session: AuthSession | null;
  init: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'loading',
  session: null,
  init: async () => {
    auth.onChange((session) => set({ session, status: session ? 'signed-in' : 'signed-out' }));
    try {
      const session = await auth.init();
      set({ session, status: session ? 'signed-in' : 'signed-out' });
    } catch {
      set({ session: null, status: 'signed-out' });
    }
  },
}));
