import { writable } from 'svelte/store';

export type Notification = {
  id: symbol;
  message: string;
  kind: 'info' | 'success' | 'error';
  dismiss: () => void;
};

// Components publish only in browser effects, keeping server rendering free of shared messages.
export const notifications = writable<Notification[]>([]);
export const notificationHosts = writable<symbol[]>([]);
