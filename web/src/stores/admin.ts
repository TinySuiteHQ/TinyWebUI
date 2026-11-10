/** How many people wait for approval: shown on the sidebar's Admin item and the People tab. */
import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useAdmin = defineStore('admin', () => {
  const waiting = ref(0);
  const markWaiting = (users: { status: string }[]) => { waiting.value = users.filter((u) => u.status === 'pending').length; };
  return { waiting, markWaiting };
});
