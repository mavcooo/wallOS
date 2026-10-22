import { create } from 'zustand';

export type ToastTone = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
}

interface ToastState {
  toasts: Toast[];
  push(toast: Omit<Toast, 'id'>): void;
  dismiss(id: string): void;
}

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  push(toast) {
    const id = crypto.randomUUID();
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }].slice(-4) }));
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
    }, 4200);
  },
  dismiss(id) {
    set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
  },
}));
